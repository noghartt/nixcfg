import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	buildFacts,
	canonicalize,
	deletionVerdict,
	type Exec,
	exists,
	type Facts,
	inProject,
	inWorkerWorktree,
	isProtected,
	isSensitivePath,
	isWithin,
	resolvePath,
	scopedVerdict,
	selfHarm,
	terminationVerdict,
	type Verdict,
} from "./policy.ts";
import { invocationOf, operands, type ParsedCommand, parseCommand } from "./shell.ts";

interface DestructivePattern {
	label: string;
	pattern: RegExp;
}

const DELETION = "file or directory deletion";
const TERMINATION = "process termination";

const destructivePatterns: DestructivePattern[] = [
	{
		label: "privileged command",
		pattern: /(^|[;&|()\n]\s*)sudo\b/i,
	},
	{
		label: DELETION,
		pattern: /(^|[;&|()\n]\s*)(?:command\s+)?(?:rm|rmdir|unlink|shred)\b|\bxargs\b[^\n;&|]*\b(?:rm|unlink|shred)\b/i,
	},
	{
		label: "find deletion",
		pattern: /\bfind\b[^\n;&|]*\s(?:-delete\b|-exec(?:dir)?\s+(?:rm|unlink|shred)\b)/i,
	},
	{
		label: "filesystem or block-device overwrite",
		pattern: /(^|[;&|()\n]\s*)(?:dd|mkfs(?:\.[\w-]+)?|wipefs|fdisk|sfdisk|parted)\b/i,
	},
	{
		label: "file truncation",
		pattern: /(^|[;&|()\n]\s*)truncate\b/i,
	},
	{
		label: "forced file replacement",
		pattern: /(^|[;&|()\n]\s*)(?:cp|mv)\b[^\n;&|]*(?:-f|--force)\b/i,
	},
	{
		label: "recursive permission or ownership change",
		pattern: /(^|[;&|()\n]\s*)(?:chmod|chown|chgrp)\b[^\n;&|]*(?:-R|--recursive)\b/i,
	},
	{
		label: "Git worktree or history destruction",
		pattern:
			/\bgit\s+(?:(?:reset|clean|restore|rebase)\b|checkout\b[^\n;&|]*\s--(?:\s|$)|branch\b[^\n;&|]*\s-D\b|commit\b[^\n;&|]*--amend\b|stash\s+(?:drop|clear)\b|reflog\s+expire\b)/i,
	},
	{
		label: "destructive Git remote operation",
		pattern: /\bgit\s+push\b[^\n;&|]*(?:--force(?:-with-lease)?\b|\s--delete\b|\s:\S+)/i,
	},
	{
		label: TERMINATION,
		pattern: /(^|[;&|()\n]\s*)(?:kill|killall|pkill)\b|\bxargs\b[^\n;&|]*\bkill\b/i,
	},
	{
		label: "system shutdown or restart",
		pattern: /(^|[;&|()\n]\s*)(?:shutdown|reboot|halt|poweroff)\b/i,
	},
	{
		label: "service removal or shutdown",
		pattern: /\b(?:systemctl\s+(?:disable|mask|stop)|launchctl\s+(?:bootout|remove|unload))\b/i,
	},
	{
		label: "container deletion or pruning",
		pattern:
			/\b(?:docker|podman)\s+(?:(?:container|image|network|volume|system)\s+)?(?:rm|rmi|prune)\b|\bdocker\s+compose\b[^\n;&|]*\sdown\b[^\n;&|]*(?:-v|--volumes)\b/i,
	},
	{
		label: "infrastructure destruction",
		pattern:
			/\bterraform\s+destroy\b|\b(?:kubectl|helm)\s+(?:delete|uninstall)\b|\b(?:aws|gcloud|az)\b[^\n;&|]*\b(?:delete|destroy|terminate)\b/i,
	},
	{
		label: "database destruction",
		pattern: /\b(?:drop\s+(?:database|schema|table)|truncate\s+table)\b/i,
	},
	{
		label: "package removal",
		pattern:
			/(^|[;&|()\n]\s*)(?:(?:apt(?:-get)?|dnf|yum|pacman|brew|npm|pnpm|yarn|pipx?)\s+(?:remove|uninstall|autoremove)|nix-collect-garbage\b|nix\s+store\s+gc\b)/i,
	},
	{
		label: "system configuration activation",
		pattern: /\b(?:nixos-rebuild|darwin-rebuild|home-manager)\s+switch\b/i,
	},
	{
		label: "write to a protected system or credential path",
		pattern:
			/(?:>|\btee\b)[^\n;&|]*(?:\/(?:etc|usr|bin|sbin|System|nix\/store)\/|~\/\.(?:ssh|gnupg)\/|~\/\.config\/opnix\/)/i,
	},
];

// Their targets are files, so they pass when every one stays inside the project.
const SCOPED = new Set(["file truncation", "forced file replacement", "recursive permission or ownership change"]);

const SHELLS = new Set(["bash", "sh", "zsh", "dash"]);

// Wording adapted from Claude Code's dangerous-removal reminder, so a refused
// agent finishes the rest of the task instead of routing around the guard.
const NOT_RUN =
	"The command was NOT run; do not claim it succeeded. Do not work around this check by splitting, scripting, or re-issuing it through another tool or shell. Finish the rest of the task without it, tell the user what you wanted to do and why, and leave this step to them.";

interface Unresolved {
	category: string;
	why: string;
}

interface Evaluation {
	self?: string;
	allowed: string[];
	unresolved: Unresolved[];
}

function classifyCommand(command: string): string | undefined {
	return destructivePatterns.find(({ pattern }) => pattern.test(command))?.label;
}

function display(value: string, maxLength = 1200): string {
	return value.length <= maxLength ? value : `${value.slice(0, maxLength)}\n…`;
}

export default function destructiveGuard(pi: ExtensionAPI) {
	const guardDir = dirname(fileURLToPath(import.meta.url));
	const sessionFiles = new Set<string>();
	const pendingCreates = new Map<string, string>();
	// A `/unsupervised` run has nobody to answer a dialog, so what the checks do
	// not clear is refused and the run goes on without it. Typing anything else ends
	// it. The variable carries it into orchestrator workers and subagents.
	let unsupervised = process.env.OMO_UNSUPERVISED === "1";

	const exec = (cwd?: string): Exec => async (command, args) => {
		const result = await pi.exec(command, args, cwd ? { cwd } : undefined);
		return { stdout: result.stdout, code: result.code };
	};

	const gitRoot = async (cwd: string): Promise<string | undefined> => {
		const result = await exec(cwd)("git", ["rev-parse", "--show-toplevel"]);
		return result.code === 0 ? canonicalize(result.stdout.trim()) : undefined;
	};

	// A session started in the main checkout edits its Herdr worktrees (~/.herdr/worktrees/...)
	// and vice versa; every worktree of the repository is the same project. Bare entries hold no checkout.
	const projectRoots = async (cwd: string): Promise<string[]> => {
		const root = await gitRoot(cwd);
		if (!root) return [];
		const result = await exec(cwd)("git", ["worktree", "list", "--porcelain"]);
		const worktrees =
			result.code === 0
				? result.stdout
						.split("\n\n")
						.map((block) => block.split("\n"))
						.filter((lines) => lines[0]?.startsWith("worktree ") && !lines.includes("bare"))
						.map((lines) => lines[0].slice("worktree ".length))
				: [];
		return [...new Set([root, ...(await Promise.all(worktrees.map(canonicalize)))])];
	};

	const evaluate = async (
		parsed: ParsedCommand,
		startCwd: string,
		facts: Facts,
		depth = 0,
	): Promise<Evaluation> => {
		const result: Evaluation = { allowed: [], unresolved: [] };
		let cwd: string | undefined = startCwd;
		let repoRoot: string | undefined | null = null;
		for (const segment of parsed.segments) {
			const invocation = invocationOf(segment);
			if (cwd) {
				const harm = await selfHarm(segment, invocation, cwd, facts);
				if (harm) return { ...result, self: harm };
			}
			if (invocation?.name === "cd") {
				const target = operands(invocation.args)[0];
				cwd = segment.dynamic || !cwd ? undefined : await resolvePath(target?.text ?? "~", cwd, facts.home);
				continue;
			}
			const inner =
				invocation && SHELLS.has(invocation.name)
					? invocation.args[invocation.args.findIndex((arg) => arg.text === "-c") + 1]?.text
					: invocation?.name === "eval"
						? invocation.args.map((arg) => arg.text).join(" ")
						: undefined;
			if (inner !== undefined && depth < 3) {
				if (segment.dynamic || !cwd) {
					if (classifyCommand(inner)) result.unresolved.push({ category: "nested shell", why: "nested command is only known at run time" });
					continue;
				}
				const nested = await evaluate(parseCommand(inner), cwd, facts, depth + 1);
				if (nested.self) return { ...result, self: nested.self };
				result.allowed.push(...nested.allowed);
				result.unresolved.push(...nested.unresolved);
				continue;
			}
			const category = classifyCommand(segment.text);
			if (!category) continue;
			let verdict: Verdict;
			if (segment.dynamic || !cwd) {
				verdict = { kind: "unresolved", why: "its arguments are only known at run time" };
			} else if (category === DELETION && invocation && /^(?:rm|rmdir|unlink|shred)$/.test(invocation.name)) {
				if (repoRoot === null) repoRoot = await gitRoot(cwd);
				verdict = await deletionVerdict(invocation, cwd, facts, repoRoot);
			} else if (category === TERMINATION && invocation && /^(?:kill|pkill|killall)$/.test(invocation.name)) {
				verdict = await terminationVerdict(invocation, exec(cwd));
			} else if (SCOPED.has(category) && invocation && /^(?:truncate|cp|mv|chmod|chown|chgrp)$/.test(invocation.name)) {
				verdict = await scopedVerdict(invocation, cwd, facts);
			} else {
				verdict = { kind: "unresolved", why: category };
			}
			if (verdict.kind === "self") return { ...result, self: verdict.why };
			if (verdict.kind === "allow") result.allowed.push(verdict.why);
			else result.unresolved.push({ category, why: verdict.why });
		}
		for (const body of parsed.heredocs) {
			const category = classifyCommand(body);
			if (category) {
				result.unresolved.push({ category: `${category} in heredoc`, why: "a heredoc carries a destructive command" });
			}
		}
		return result;
	};

	const audit = (decision: string, tool: string, subject: string, reason: string) => {
		pi.appendEntry("destructive-guard", { decision, tool, subject: display(subject, 400), reason });
	};

	const confirmOrBlock = async (
		ctx: ExtensionContext,
		title: string,
		details: string,
	): Promise<{ block: true; reason: string } | undefined> => {
		if (unsupervised) return { block: true, reason: `${title} Unsupervised run: nobody is here to confirm it. ${NOT_RUN}` };
		if (!ctx.hasUI) return { block: true, reason: `${title} Confirmation is unavailable. ${NOT_RUN}` };
		if (await ctx.ui.confirm(title, details)) return undefined;
		return { block: true, reason: `${title} Declined by the user. ${NOT_RUN}` };
	};

	// Whatever the deterministic checks cannot clear goes to the user; no model
	// approves on their behalf.
	const confirmUnresolved = async (
		ctx: ExtensionContext,
		tool: string,
		subject: string,
		unresolved: Unresolved[],
		title: string,
		details: string,
	) => {
		const concerns = unresolved.map((item) => `- ${item.category}: ${item.why}`).join("\n");
		const outcome = await confirmOrBlock(ctx, title, `${details}\n\n${concerns}`);
		audit(outcome ? "blocked" : "user-allow", tool, subject, concerns);
		return outcome;
	};

	const selfBlock = (tool: string, subject: string, why: string) => {
		audit("self-block", tool, subject, why);
		return { block: true as const, reason: `Blocked: ${why}. The agent may not stop itself or change its own configuration or credentials. ${NOT_RUN}` };
	};

	pi.on("session_start", () => {
		sessionFiles.clear();
	});

	pi.on("input", async (event, ctx) => {
		if (event.source === "extension" || event.streamingBehavior === "steer") return;
		unsupervised = /^\/unsupervised(?:\s|$)/.test(event.text.trimStart());
		if (unsupervised) {
			process.env.OMO_UNSUPERVISED = "1";
			if (ctx.hasUI) ctx.ui.notify("Unsupervised run: destructive actions the guard cannot clear are refused, not asked.", "info");
		} else delete process.env.OMO_UNSUPERVISED;
	});

	pi.on("tool_result", (event) => {
		const path = pendingCreates.get(event.toolCallId);
		if (path === undefined) return;
		pendingCreates.delete(event.toolCallId);
		if (!event.isError) sessionFiles.add(path);
	});

	// In an agentbox sandbox (OmO cloud mode), bash, write and edit run inside a
	// disposable container, so every command there is allowed. Other tools (MCP,
	// web) still act outside it and keep their checks.
	const sandboxed = (tool: string) => Boolean(process.env.OMO_CLOUD_SANDBOX) && /^(?:bash|write|edit)$/.test(tool);

	pi.on("tool_call", async (event, ctx) => {
		if (sandboxed(event.toolName)) return undefined;

		if (/(^|[_-])(delete|remove|destroy|drop|truncate|wipe|prune)([_-]|$)/i.test(event.toolName)) {
			const subject = JSON.stringify(event.input, null, 2);
			return confirmUnresolved(
				ctx,
				event.toolName,
				subject,
				[{ category: "destructive tool", why: event.toolName }],
				"Allow destructive tool?",
				`Tool: ${event.toolName}\nWorking directory: ${ctx.cwd}\n\n${display(subject)}`,
			);
		}
		if (event.toolName !== "bash" && event.toolName !== "write" && event.toolName !== "edit") return undefined;
		// The project is the session cwd's repository, not wherever a command `cd`s to.
		const facts = await buildFacts(sessionFiles, guardDir, await projectRoots(ctx.cwd));

		if (event.toolName === "bash") {
			const command = (event.input as { command?: unknown }).command;
			if (typeof command !== "string") return undefined;

			const evaluation = await evaluate(parseCommand(command), await canonicalize(ctx.cwd), facts);
			if (evaluation.self) return selfBlock("bash", command, evaluation.self);
			if (!evaluation.unresolved.length) {
				if (evaluation.allowed.length) audit("auto-allow", "bash", command, evaluation.allowed.join("; "));
				return undefined;
			}
			return confirmUnresolved(
				ctx,
				"bash",
				command,
				evaluation.unresolved,
				"Allow destructive command?",
				`Working directory: ${ctx.cwd}\n\n${display(command)}`,
			);
		}

		if (event.toolName !== "write" && event.toolName !== "edit") return undefined;
		// OmO's cloud mode writes on a remote host; checks against this disk and
		// its git state would judge the wrong files.
		if (process.env.OMO_CLOUD) return undefined;

		const rawPath = (event.input as { path?: unknown }).path;
		if (typeof rawPath !== "string") return undefined;

		const inputPath = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
		const resolvedPath = resolve(ctx.cwd, inputPath);
		const [projectRoot, targetPath] = await Promise.all([canonicalize(ctx.cwd), canonicalize(resolvedPath)]);
		if (isProtected(targetPath, facts) || isProtected(resolvedPath, facts)) {
			return selfBlock(event.toolName, targetPath, `${event.toolName} to the agent's own configuration or credentials (${targetPath})`);
		}

		const existed = await exists(resolvedPath);
		if (event.toolName === "write" && !existed) pendingCreates.set(event.toolCallId, targetPath);

		const inTmp = facts.tmpRoots.some((root) => root !== targetPath && isWithin(root, targetPath));
		const inScope = inWorkerWorktree(targetPath, facts) || inProject(targetPath, facts);
		const outsideProject = !isWithin(projectRoot, targetPath) && !inTmp && !inScope;
		const sensitive = isSensitivePath(targetPath);
		// Inside the project an overwrite is the agent's call; in a cwd with no repository it
		// still asks unless this session wrote the file.
		const overwritesFile = event.toolName === "write" && existed && !sessionFiles.has(targetPath) && !inTmp && !inScope;

		if (!outsideProject && !sensitive && !overwritesFile) return undefined;

		const unresolved: Unresolved[] = [
			outsideProject ? { category: "outside project", why: "target is outside the current project" } : undefined,
			sensitive ? { category: "sensitive path", why: "target looks sensitive" } : undefined,
			overwritesFile ? { category: "overwrite", why: "write replaces a file with uncommitted or untracked content" } : undefined,
		].filter((item): item is Unresolved => item !== undefined);

		return confirmUnresolved(
			ctx,
			event.toolName,
			targetPath,
			unresolved,
			`Allow ${event.toolName} operation?`,
			`Project: ${projectRoot}\nTarget: ${targetPath}`,
		);
	});
}

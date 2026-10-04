import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { judge, judgeAvailable } from "./judge.ts";
import {
	buildFacts,
	canonicalize,
	deletionVerdict,
	type Exec,
	exists,
	type Facts,
	isProtected,
	isWithin,
	resolvePath,
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

// Shared, remote, or irreversible at system level: only the user approves these.
const CONFIRM_ONLY = new Set([
	"privileged command",
	"filesystem or block-device overwrite",
	"destructive Git remote operation",
	"system shutdown or restart",
	"infrastructure destruction",
	"database destruction",
	"package removal",
	"system configuration activation",
	"write to a protected system or credential path",
]);

const sensitivePathPatterns = [
	/(^|\/)\.git(?:\/|$)/,
	/(^|\/)\.env(?:\.|\/|$)/i,
	/(^|\/)(?:credentials?|secrets?)(?:\.|\/|$)/i,
	/(^|\/)(?:id_(?:rsa|dsa|ecdsa|ed25519)|authorized_keys|known_hosts)$/i,
	/(^|\/)\.ssh(?:\/|$)/,
	/(^|\/)\.gnupg(?:\/|$)/,
	/(^|\/)\.config\/opnix(?:\/|$)/,
];

const SHELLS = new Set(["bash", "sh", "zsh", "dash"]);

// Wording adapted from Claude Code's dangerous-removal reminder, so a refused
// agent finishes the rest of the task instead of routing around the guard.
const NOT_RUN =
	"The command was NOT run; do not claim it succeeded. Do not work around this check by splitting, scripting, or re-issuing it through another tool or shell. Finish the rest of the task without it, tell the user what you wanted to do and why, and leave this step to them.";

interface Unresolved {
	category: string;
	why: string;
	confirmOnly: boolean;
	facts?: Record<string, unknown>;
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

function isSensitivePath(path: string): boolean {
	return sensitivePathPatterns.some((pattern) => pattern.test(path));
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((block: { type?: string; text?: string }) => (block.type === "text" && block.text ? [block.text] : []))
		.join("\n");
}

function sessionContext(ctx: ExtensionContext): { userMessages: string[]; recentActions: string[] } {
	const userMessages: string[] = [];
	const recentActions: string[] = [];
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message") continue;
		const message = entry.message as { role?: string; content?: unknown };
		if (message.role === "user") {
			const text = textOf(message.content).trim();
			if (text) userMessages.push(text);
		} else if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content as { type?: string; name?: string; arguments?: unknown }[]) {
				if (block.type === "toolCall") recentActions.push(`${block.name}: ${JSON.stringify(block.arguments)}`);
			}
		}
	}
	return { userMessages: userMessages.slice(-6), recentActions: recentActions.slice(-12) };
}

export default function destructiveGuard(pi: ExtensionAPI) {
	const guardDir = dirname(fileURLToPath(import.meta.url));
	const sessionFiles = new Set<string>();
	const pendingCreates = new Map<string, string>();
	let sessionStartedAt = Date.now();

	const exec = (cwd?: string): Exec => async (command, args) => {
		const result = await pi.exec(command, args, cwd ? { cwd } : undefined);
		return { stdout: result.stdout, code: result.code };
	};

	const gitRoot = async (cwd: string): Promise<string | undefined> => {
		const result = await exec(cwd)("git", ["rev-parse", "--show-toplevel"]);
		return result.code === 0 ? canonicalize(result.stdout.trim()) : undefined;
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
					if (classifyCommand(inner)) result.unresolved.push({ category: "nested shell", why: "nested command is only known at run time", confirmOnly: false });
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
				verdict = await terminationVerdict(invocation, exec(cwd), facts);
			} else {
				verdict = { kind: "unresolved", why: category, confirmOnly: CONFIRM_ONLY.has(category) };
			}
			if (verdict.kind === "self") return { ...result, self: verdict.why };
			if (verdict.kind === "allow") result.allowed.push(verdict.why);
			else {
				result.unresolved.push({
					category,
					why: verdict.why,
					confirmOnly: Boolean(verdict.confirmOnly) || CONFIRM_ONLY.has(category),
					facts: verdict.facts,
				});
			}
		}
		for (const body of parsed.heredocs) {
			const category = classifyCommand(body);
			if (category) {
				result.unresolved.push({ category: `${category} in heredoc`, why: "a heredoc carries a destructive command", confirmOnly: CONFIRM_ONLY.has(category) });
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
		if (!ctx.hasUI) return { block: true, reason: `${title} Confirmation is unavailable. ${NOT_RUN}` };
		if (await ctx.ui.confirm(title, details)) return undefined;
		return { block: true, reason: `${title} Declined by the user. ${NOT_RUN}` };
	};

	const judgeOrConfirm = async (
		ctx: ExtensionContext,
		tool: string,
		subject: string,
		unresolved: Unresolved[],
		title: string,
		details: string,
	) => {
		let note = "";
		if (unresolved.some((item) => item.confirmOnly)) note = "Needs your approval: shared, remote, or system-level effect.";
		else if (!judgeAvailable()) note = "Jev unavailable (TYPESAFE_API_KEY unset).";
		else {
			try {
				const verdict = await judge(
					{
						...sessionContext(ctx),
						action: {
							tool,
							input: display(subject, 2000),
							cwd: ctx.cwd,
							concerns: unresolved.map(({ category, why, facts }) => ({ category, why, facts })),
						},
					},
					ctx.signal,
				);
				if (verdict.allow) {
					audit("jev-allow", tool, subject, verdict.summary);
					if (ctx.hasUI) ctx.ui.notify(`Auto-approved by Jev (${verdict.summary})`, "info");
					return undefined;
				}
				note = `Jev did not clear it: ${verdict.summary}`;
			} catch (error) {
				note = `Jev failed: ${(error as Error).message}`;
			}
		}
		const outcome = await confirmOrBlock(ctx, title, `${details}\n\n${unresolved.map((item) => `- ${item.category}: ${item.why}`).join("\n")}\n${note}`);
		audit(outcome ? "blocked" : "user-allow", tool, subject, note);
		return outcome;
	};

	const selfBlock = (tool: string, subject: string, why: string) => {
		audit("self-block", tool, subject, why);
		return { block: true as const, reason: `Blocked: ${why}. The agent may not stop itself or change its own configuration or credentials. ${NOT_RUN}` };
	};

	pi.on("session_start", () => {
		sessionStartedAt = Date.now();
		sessionFiles.clear();
	});

	pi.on("tool_result", (event) => {
		const path = pendingCreates.get(event.toolCallId);
		if (path === undefined) return;
		pendingCreates.delete(event.toolCallId);
		if (!event.isError) sessionFiles.add(path);
	});

	pi.on("tool_call", async (event, ctx) => {
		const facts = await buildFacts(sessionFiles, sessionStartedAt, guardDir);

		if (/(^|[_-])(delete|remove|destroy|drop|truncate|wipe|prune)([_-]|$)/i.test(event.toolName)) {
			const subject = JSON.stringify(event.input, null, 2);
			return judgeOrConfirm(
				ctx,
				event.toolName,
				subject,
				[{ category: "destructive tool", why: event.toolName, confirmOnly: false }],
				"Allow destructive tool?",
				`Tool: ${event.toolName}\nWorking directory: ${ctx.cwd}\n\n${display(subject)}`,
			);
		}

		if (event.toolName === "bash") {
			const command = (event.input as { command?: unknown }).command;
			if (typeof command !== "string") return undefined;

			const evaluation = await evaluate(parseCommand(command), await canonicalize(ctx.cwd), facts);
			if (evaluation.self) return selfBlock("bash", command, evaluation.self);
			if (!evaluation.unresolved.length) {
				if (evaluation.allowed.length) audit("auto-allow", "bash", command, evaluation.allowed.join("; "));
				return undefined;
			}
			return judgeOrConfirm(
				ctx,
				"bash",
				command,
				evaluation.unresolved,
				"Allow destructive command?",
				`Working directory: ${ctx.cwd}\n\n${display(command)}`,
			);
		}

		if (event.toolName !== "write" && event.toolName !== "edit") return undefined;

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
		const outsideProject = !isWithin(projectRoot, targetPath) && !inTmp;
		const sensitive = isSensitivePath(targetPath);
		let overwritesFile = event.toolName === "write" && existed && !sessionFiles.has(targetPath) && !inTmp;
		if (overwritesFile && !outsideProject && !sensitive) {
			const git = exec(dirname(targetPath));
			const tracked = await git("git", ["ls-files", "--error-unmatch", "--", basename(targetPath)]);
			const unchanged = tracked.code === 0 && (await git("git", ["diff", "--quiet", "HEAD", "--", basename(targetPath)])).code === 0;
			// A tracked file with no uncommitted changes can be restored from Git.
			if (unchanged) overwritesFile = false;
		}

		if (!outsideProject && !sensitive && !overwritesFile) return undefined;

		const unresolved: Unresolved[] = [
			outsideProject ? { category: "outside project", why: "target is outside the current project", confirmOnly: false } : undefined,
			sensitive ? { category: "sensitive path", why: "target looks sensitive", confirmOnly: true } : undefined,
			overwritesFile
				? { category: "overwrite", why: "write replaces a file with uncommitted or untracked content", confirmOnly: false }
				: undefined,
		].filter((item): item is Unresolved => item !== undefined);

		return judgeOrConfirm(
			ctx,
			event.toolName,
			targetPath,
			unresolved,
			`Allow ${event.toolName} operation?`,
			`Project: ${projectRoot}\nTarget: ${targetPath}`,
		);
	});
}

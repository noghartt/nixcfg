// Cloud mode: the session keeps running on this machine (TUI, models, auth,
// memory), while the environment the model acts on is a remote host reached
// over SSH. read/write/edit/grep and bash (direct, from eval's tool.* helpers,
// and `!` commands) operate on the target; tools that only make sense
// locally are switched off while it is on. See docs/cloud-mode.md.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createEditTool, createGrepTool, createReadTool, createWriteTool } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { remoteGrep } from "./grep.ts";
import { registerPublish } from "./publish.ts";
import { activeTools, legacyTarget, type Role, roleOf } from "./session.ts";
import { editOps, exec, ptyCommand, q, readOps, run, type Target, userBashOps, writeOps } from "./ssh.ts";

const ENTRY = "cloud-mode";
// Child sessions (task subagents, in-process or spawned) inherit the resolved
// target through the environment, so they act in the same remote directory.
const ENV = "OMO_CLOUD";
const STATUS = "cloud-mode";
// Language servers, git worktrees, and the desktop only exist on this machine;
// apply_patch writes the local disk and has no remote operations.
const LOCAL_ONLY = /^(lsp_.*|worktree_agents|computer|computer_actions|apply_patch)$/;

// `spec` is always the resolved host directory.
type Entry = { spec: string | null };
type Resolved = { target: Target; spec: string };

const describe = (target: Target): string => `${target.dest}:${target.cwd}`;

function parseSpec(spec: string): { dest: string; path?: string } {
	const colon = spec.indexOf(":");
	return colon < 0 ? { dest: spec } : { dest: spec.slice(0, colon), path: spec.slice(colon + 1) || undefined };
}

async function resolveTarget(spec: string, localCwd: string): Promise<Resolved> {
	const { dest, path } = parseSpec(spec);
	const home = (await exec({ dest }, `printf '%s' "$HOME"`)).toString();
	const local = homedir();
	// By default the same home-relative directory as here: ~/www/x -> remote ~/www/x.
	let wanted = path ?? (localCwd === local || localCwd.startsWith(`${local}/`) ? home + localCwd.slice(local.length) : localCwd);
	if (wanted === "~") wanted = home;
	else if (wanted.startsWith("~/")) wanted = home + wanted.slice(1);
	const probe = await run({ dest }, `cd -- ${q(wanted)} && pwd -P`);
	if (probe.code !== 0) {
		throw new Error(`${wanted} does not exist on ${dest}. Create or clone it there, or pass ${dest}:/path.`);
	}
	const cwd = probe.stdout.toString().trim();
	return { target: { dest, home, cwd }, spec: `${dest}:${cwd}` };
}

function promptSection(target: Target, role: Role): string {
	return [
		"## Cloud mode",
		"",
		`This session's environment is the remote host \`${target.dest}\`, working directory \`${target.cwd}\` (home \`${target.home}\`).`,
		role === "top"
			? "To push a branch or open a draft PR, use the `publish` tool: it brings the branch back to the user's machine and pushes it over SSH with their keys (never a force push, never the default branch). Name branches by the repository's own conventions, and publish only when the task asks for a push or PR."
			: "Pushing is the parent's job: do not try to push or open pull requests.",
		"The `<cwd>` in environment_context is this session's local directory, not where you work.",
		"read, write, edit, grep and bash (including bash_output/bash_input/kill_bash sessions, and `tool.*` calls inside eval) run on the remote host; relative paths resolve against the remote working directory, and servers you start listen there.",
		"The eval kernels themselves (Python/JavaScript) run locally: inside eval, touch project files and run commands only through `tool.*` helpers, never through open(), subprocess, fs, or Bun.$.",
		"Language-server, worktree, apply_patch, and computer-use tools are unavailable in cloud mode; use edit/write for file changes.",
	].join("\n");
}

export default function cloudMode(pi: ExtensionAPI) {
	let target: Target | undefined;
	// Set when cloud mode was requested but could not start. Tools then refuse
	// instead of silently acting on this machine.
	let failure: string | undefined;
	let toolsRegistered = false;
	let savedActive: string[] | undefined;
	// Settled at session start: a task child keeps its own tool restrictions and never publishes.
	let role: Role = "top";

	pi.registerFlag("cloud", { description: "Run this session's tools on a remote host: host or host:/path", type: "string" });

	const exposureOf = (name: string) => pi.getAllTools().find((tool) => tool.name === name)?.exposure;

	// Overrides exist only once cloud mode is first enabled, so ordinary
	// sessions keep the engine's own tools; after /cloud off they fall back to
	// fresh local instances. Rebuilt tools get no ctx, so they resolve paths
	// against the remote cwd instead of the local session cwd.
	function registerTools() {
		if (toolsRegistered) return;
		toolsRegistered = true;
		if (role === "top") registerPublish(pi, () => target);
		const local = process.cwd();
		const factories = [
			["read", createReadTool, (t: Target) => ({ operations: readOps(t) })],
			["write", createWriteTool, (t: Target) => ({ operations: writeOps(t) })],
			["edit", createEditTool, (t: Target) => ({ operations: editOps(t) })],
		] as const;
		for (const [name, create, options] of factories) {
			pi.registerTool({
				...create(local),
				exposure: exposureOf(name),
				async execute(id, params, signal, onUpdate, ctx) {
					if (!target) return create(ctx.cwd).execute(id, params, signal, onUpdate, ctx);
					return create(target.cwd, options(target) as never).execute(id, params, signal, onUpdate);
				},
			} as never);
		}
		pi.registerTool({
			...createGrepTool(local),
			exposure: exposureOf("grep"),
			async execute(id, params, signal, onUpdate, ctx) {
				if (!target) return createGrepTool(ctx.cwd).execute(id, params, signal, onUpdate, ctx);
				return remoteGrep(target, params, signal);
			},
		} as never);
	}

	function applyActiveTools() {
		const active = pi.getActiveTools();
		savedActive ??= active;
		const next = activeTools(active, role, LOCAL_ONLY);
		if (next.length !== active.length || next.some((name, i) => name !== active[i])) pi.setActiveTools(next);
	}

	function show(ctx: ExtensionContext) {
		ctx.ui.setStatus(STATUS, target ? ctx.ui.theme.fg("accent", `cloud: ${describe(target)}`) : undefined);
	}

	// `previous` is the session's last entry; the new target is recorded only when
	// it differs (null records unconditionally).
	async function enable(spec: string, ctx: ExtensionContext, previous: Entry | null | undefined) {
		const resolved = await resolveTarget(spec, ctx.cwd);
		target = resolved.target;
		failure = undefined;
		// Task children read the target from here (a task daemon hosts them in this process); only the
		// top session writes it, so a child never changes its siblings' target.
		if (role === "top") {
			process.env[ENV] = resolved.spec;
			delete process.env.OMO_CLOUD_SANDBOX;
		}
		registerTools();
		applyActiveTools();
		if (previous === null || previous?.spec !== resolved.spec) pi.appendEntry(ENTRY, { spec: resolved.spec } satisfies Entry);
		show(ctx);
	}

	function disable(ctx: ExtensionContext) {
		target = undefined;
		failure = undefined;
		if (role === "top") {
			delete process.env[ENV];
			delete process.env.OMO_CLOUD_SANDBOX;
		}
		if (savedActive) pi.setActiveTools(savedActive);
		savedActive = undefined;
		pi.appendEntry(ENTRY, { spec: null } satisfies Entry);
		show(ctx);
	}

	pi.on("session_start", async (_event, ctx) => {
		const flag = pi.getFlag("cloud");
		const entry = ctx.sessionManager
			.getBranch()
			.findLast((e) => e.type === "custom" && e.customType === ENTRY) as { data?: Entry } | undefined;
		role = roleOf(ctx);
		// The flag wins, then the inherited environment, then the resumed entry.
		let spec: string | undefined;
		let legacy: string | undefined;
		if (typeof flag === "string" && flag) {
			spec = flag;
			legacy = legacyTarget({ spec });
		} else if (process.env[ENV] || process.env.OMO_CLOUD_SANDBOX) {
			spec = process.env[ENV] || "(inherited)";
			legacy = legacyTarget({ spec, env: process.env });
		} else if (entry?.data?.spec) {
			spec = entry.data.spec;
			legacy = legacyTarget({ spec, entry: entry.data });
		}
		if (!spec) return;
		if (legacy) {
			failure = `cloud mode (${spec}) cannot start: ${legacy}, and sandbox support was removed.`;
			if (ctx.hasUI) ctx.ui.notify(`${failure} Tools are blocked; pick a plain SSH target with /cloud <host[:path]>, or /cloud off.`, "error");
			else console.error(`omo: ${failure}`);
			return;
		}
		try {
			await enable(spec, ctx, entry?.data);
			if (target) ctx.ui.notify(`Cloud mode: ${describe(target)}`, "info");
		} catch (error) {
			target = undefined;
			failure = `cloud mode (${spec}) failed to start: ${(error as Error).message}`;
			if (ctx.hasUI) ctx.ui.notify(`${failure} Tools are blocked; fix it with /cloud <host[:path]> or /cloud off.`, "error");
			else console.error(`omo: ${failure}`);
		}
	});

	pi.registerCommand("cloud", {
		description: "Run this session's tools on a remote host: /cloud <host[:path]> | off",
		handler: async (args, ctx) => {
			const spec = args.trim();
			if (!spec) {
				ctx.ui.notify(target ? `Cloud mode: ${describe(target)}` : "Cloud mode is off. Usage: /cloud <host[:path]>", "info");
				return;
			}
			if (spec === "off") {
				if (target || failure) disable(ctx);
				ctx.ui.notify("Cloud mode off: tools run locally again.", "info");
				return;
			}
			const legacy = legacyTarget({ spec });
			if (legacy) {
				ctx.ui.notify(`Cloud mode failed: ${legacy}, and sandbox support was removed; use a plain SSH host.`, "error");
				return;
			}
			try {
				await enable(spec, ctx, null);
				if (target) ctx.ui.notify(`Cloud mode: ${describe(target)}`, "info");
			} catch (error) {
				ctx.ui.notify(`Cloud mode failed: ${(error as Error).message}`, "error");
			}
		},
	});

	// Model switches can swap edit for apply_patch again; re-assert before each prompt.
	pi.on("before_agent_start", async (event) => {
		if (failure) {
			return { systemPrompt: `${event.systemPrompt}\n\n## Cloud mode\n\nThe user asked for ${failure} Every tool is blocked until they fix it; tell them, and do not try to work locally.` };
		}
		if (!target) return;
		applyActiveTools();
		return { systemPrompt: `${event.systemPrompt}\n\n${promptSection(target, role)}` };
	});

	// Tool arguments are cloned before this hook, so the rewrite reaches execution
	// only; the model keeps seeing the command it wrote.
	pi.on("tool_call", (event) => {
		if (failure) return { block: true, reason: `Blocked: ${failure}` };
		if (!target) return;
		if (LOCAL_ONLY.test(event.toolName)) {
			return { block: true, reason: `${event.toolName} is unavailable in cloud mode (${target.dest}); it only works on the local machine.` };
		}
		if (event.toolName === "bash") {
			const input = event.input as { command?: unknown };
			if (typeof input.command === "string") input.command = ptyCommand(target, input.command);
		}
	});

	pi.on("user_bash", () => {
		if (failure) return { result: { output: `Blocked: ${failure}`, exitCode: 1, cancelled: false, truncated: false } };
		return target ? { operations: userBashOps(target) } : undefined;
	});
}

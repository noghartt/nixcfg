// Cloud mode: the session keeps running on this machine (TUI, models, auth,
// memory), while the environment the model acts on is a remote host reached
// over SSH. read/write/edit/grep and bash (direct, from eval's tool.* helpers,
// and `!` commands) operate on the target; tools that only make sense
// locally are switched off while it is on. See AGENTS.md.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createEditTool, createGrepTool, createReadTool, createWriteTool } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { basename } from "node:path";
import { Type } from "typebox";
import {
	checkOption,
	childBoxName,
	childBranch,
	childIdentity,
	collectedRef,
	type ChildIdentity,
	ensureArgs,
	isReadOnly,
	parseMarker,
	type ParentInfo,
	readTaskRecord,
	shortId,
	takeOption,
	withMarker,
} from "./child.ts";
import { remoteGrep } from "./grep.ts";
import { registerPublish } from "./publish.ts";
import { editOps, exec, isLocal, LOCAL, ptyCommand, q, readOps, run, type Target, userBashOps, writeOps } from "./ssh.ts";

const ENTRY = "cloud-mode";
// Child sessions (task subagents, in-process or spawned) inherit the resolved
// target through the environment, so they act in the same remote directory.
const ENV = "OMO_CLOUD";
const ENV_BOX = "OMO_CLOUD_SANDBOX";
// Catalog variables the sandbox opted into (agentbox env), comma-separated;
// orchestrator workers pass it on so their sandboxes get the same ones.
const ENV_VARS = "OMO_CLOUD_ENV";
// Network profile and size class handed to agentbox ensure (contract C1), passed on like the variables.
const ENV_NET = "OMO_CLOUD_NET";
const ENV_SIZE = "OMO_CLOUD_SIZE";
const STATUS = "cloud-mode";
// Language servers, git worktrees, and the desktop only exist on this machine;
// apply_patch writes the local disk and has no remote operations.
const LOCAL_ONLY = /^(lsp_.*|worktree_agents|computer|computer_actions|apply_patch)$/;

// `spec` is always the host directory; `sandbox` names the agentbox sandbox the
// tools run in, seeded from that directory's repo.
// `parent` and `branch` are set on a subagent's own sandbox, so a resumed child reattaches to it.
type Entry = { spec: string | null; sandbox?: string; parent?: string; branch?: string };
// `from`/`branch` make the sandbox a subagent's: cloned from the parent's, switched to its branch.
type Options = { env?: string[]; net?: string; size?: string; from?: string; branch?: string };
// top: the session's own sandbox. shared: a read-only subagent using its parent's. child: a write-capable subagent in its own.
type Role = { kind: "top" } | { kind: "shared" } | { kind: "child"; parent: string; branch: string };
// `expired` is the host directory holding branches of an expired sandbox this
// one replaced (agentbox ensure reports it on stderr when it recreates one).
type Resolved = { target: Target; spec: string; expired?: string; env: string[] };

// One sandbox per session by default, named after the repo so `agentbox ls`
// on the host stays readable.
function defaultSandbox(hostCwd: string, sessionId: string): string {
	const repo = basename(hostCwd).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20) || "box";
	return `${repo}-${sessionId.replace(/[^a-z0-9]/gi, "").slice(-6).toLowerCase()}`;
}

const splitVars = (value: string): string[] =>
	value
		.split(",")
		.map((name) => name.trim())
		.filter(Boolean);

const describe = (target: Target): string => `${target.dest}${target.box ? ` [sandbox ${target.box}]` : ""}:${target.cwd}`;

function parseSpec(spec: string): { dest: string; path?: string } {
	const colon = spec.indexOf(":");
	return colon < 0 ? { dest: spec } : { dest: spec.slice(0, colon), path: spec.slice(colon + 1) || undefined };
}

async function resolveTarget(
	spec: string,
	localCwd: string,
	sandbox: string | true | undefined,
	sessionId: string,
	opts: Options,
): Promise<Resolved> {
	const { dest, path } = parseSpec(spec);
	// Without a sandbox `local` would only reroute tools onto this same disk, past
	// destructive-guard's write/edit checks (they are skipped in cloud mode).
	if (dest === LOCAL && !sandbox) throw new Error(`--cloud ${LOCAL} needs --sandbox: it runs tools in one of this machine's agentbox sandboxes.`);
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
	const hostCwd = probe.stdout.toString().trim();
	const hostSpec = `${dest}:${hostCwd}`;
	// Without a sandbox there is nothing to opt in; the list is kept for orchestrator workers.
	if (!sandbox) return { target: { dest, home, cwd: hostCwd }, spec: hostSpec, env: opts.env ?? [] };

	// Creates the sandbox (cloning the directory's repo into it) or starts it,
	// and prints where the host directory lives inside.
	const box = sandbox === true ? defaultSandbox(hostCwd, sessionId) : sandbox;
	const ensured = await run({ dest }, `agentbox ${ensureArgs(box, hostCwd, opts).map(q).join(" ")}`);
	if (ensured.code !== 0) throw new Error(`sandbox ${box} on ${dest}: ${ensured.stderr.trim() || `exit ${ensured.code}`}`);
	const cwd = ensured.stdout.toString().trim().split("\n").pop() ?? "";
	const expired = /expired; its branches are archived in (\S+)/.exec(ensured.stderr)?.[1];
	if (opts.branch) {
		// The clone arrives at the parent's HEAD; an existing branch (resume) is reused.
		const git = `git -C ${q(cwd)}`;
		const switched = await run({ dest, box }, `${git} switch ${q(opts.branch)} 2>/dev/null || ${git} switch -c ${q(opts.branch)}`);
		if (switched.code !== 0) throw new Error(`sandbox ${box}: cannot switch to ${opts.branch}: ${switched.stderr.trim() || `exit ${switched.code}`}`);
	}
	// Given a list, it replaces the sandbox's opt-ins; either way the effective list is read back.
	const opted = await run({ dest }, `agentbox env ${q(box)}${opts.env ? (opts.env.length ? ` ${opts.env.map(q).join(" ")}` : " --none") : ""}`);
	if (opted.code !== 0) throw new Error(`sandbox ${box} env: ${opted.stderr.trim() || `exit ${opted.code}`}`);
	const effective = opted.stdout.toString().split("\n").filter(Boolean);
	const [boxHome = "", served] = (await exec({ dest, box }, `printf '%s\n%s' "$HOME" "\${AGENTBOX_HOST-}"`)).toString().split("\n");
	return { target: { dest, box, home: boxHome, cwd, served: served || undefined }, spec: hostSpec, expired, env: effective };
}

function promptSection(target: Target, expired: string | undefined, env: string[], role: Role): string {
	const child = role.kind === "child" ? role : undefined;
	const where = target.box
		? `the isolated sandbox \`${target.box}\` on ${isLocal(target) ? "this machine" : `host \`${target.dest}\``} (a systemd-nspawn container with its own filesystem and Nix store; the host's files and services are out of reach, and outbound network is internet-only)`
		: `the remote host \`${target.dest}\``;
	return [
		"## Cloud mode",
		"",
		`This session's environment is ${where}, working directory \`${target.cwd}\` (home \`${target.home}\`).`,
		...(child
			? [
				`You are a subagent with a sandbox of your own: a clone of your parent's sandbox \`${child.parent}\` made at its HEAD (its uncommitted changes are not in it), checked out on branch \`${child.branch}\`. Do your work and commit it on that branch. Your branches are delivered to the parent's checkout after each turn as \`${collectedRef(target.box ?? "", child.branch)}\`; the \`handoff\` tool delivers them right now. End your final message with the exact line \`Branch: ${collectedRef(target.box ?? "", child.branch)}\`, so the parent can merge or publish it.`,
				"Only committed history leaves the sandbox. Sandboxes left unused for days expire and are deleted.",
			]
			: target.box
				? [
						"Only committed history leaves the sandbox: commit your work on a branch; the user fetches branches out with `agentbox collect` on the host. Sandboxes left unused for days expire and are deleted.",
						...(role.kind === "top"
							? [
									"Subagents that can write (task tool) each get their own sandbox, a clone of this one at its HEAD with only committed work: commit what they need to see before delegating. Their result names a branch `sandbox/<their box>/task/...` that lands in this checkout; merge it (`git merge`, `git cherry-pick`) or publish it. Read-only subagents (explore, librarian, oracle, plan reviewers) share this sandbox.",
								]
							: ["You are a read-only subagent sharing your parent's sandbox: do not change files in it."]),
					]
				: []),
		...(expired
			? [
					`This sandbox was just created anew because an earlier sandbox with the same name expired from disuse: anything that was not committed there is gone. Its committed branches are archived on the host (not in here) as git bundles in \`${expired}\`; tell the user before relying on earlier work.`,
				]
			: []),
		...(target.box && env.length
			? [`These environment variables are set for every command in the sandbox: ${env.map((name) => `\`${name}\``).join(", ")}.`]
			: []),
		...(role.kind === "top"
			? [
					`To push a branch or open a draft PR, use the \`publish\` tool: it brings the branch back to the user's machine and pushes it over SSH with their keys (never a force push, never the default branch).${target.box ? " Credentials in the sandbox cannot push." : ""} Name branches by the repository's own conventions, and publish only when the task asks for a push or PR.`,
				]
			: ["Pushing is the parent's job: do not try to push or open pull requests."]),
		...(target.served
			? [`Servers you start here are reachable from the user's devices at \`${target.served}:<port>\` when they listen on 0.0.0.0 (not 127.0.0.1); give the user that address.`]
			: []),
		"The `<cwd>` in environment_context is this session's local directory, not where you work.",
		"read, write, edit, grep and bash (including bash_output/bash_input/kill_bash sessions, and `tool.*` calls inside eval) run on the remote host; relative paths resolve against the remote working directory, and servers you start listen there.",
		"The eval kernels themselves (Python/JavaScript) run locally: inside eval, touch project files and run commands only through `tool.*` helpers, never through open(), subprocess, fs, or Bun.$.",
		"Language-server, worktree, apply_patch, and computer-use tools are unavailable in cloud mode; use edit/write for file changes.",
	].join("\n");
}

export default function cloudMode(pi: ExtensionAPI) {
	let target: Target | undefined;
	let expired: string | undefined;
	let env: string[] = [];
	// Set when cloud mode was requested but could not start. Tools then refuse
	// instead of silently acting on this machine.
	let failure: string | undefined;
	let toolsRegistered = false;
	let savedActive: string[] | undefined;
	let role: Role = { kind: "top" };
	// A task child is recognised at session start but settled at its first prompt, which carries the parent's marker.
	let pendingChild: ChildIdentity | undefined;
	let hostSpec = "";
	let place: { net?: string; size?: string } = {};
	// Branch tips last delivered to the parent, so idle turns do not bundle again.
	let lastRefs = "";
	let handoffChain: Promise<unknown> = Promise.resolve();

	pi.registerFlag("cloud", { description: "Run this session's tools on a remote host: host or host:/path (`local` with --sandbox: this machine's sandboxes, no SSH)", type: "string" });
	// Boolean for --help; the engine also hands over a value (--sandbox=name).
	pi.registerFlag("sandbox", { description: "With --cloud: run tools in an isolated agentbox sandbox on that host (--sandbox=name to pick one)", type: "boolean" });
	pi.registerFlag("env", { description: "With --cloud --sandbox: catalog variables the sandbox gets (KEY,KEY; agentbox env)", type: "string" });
	pi.registerFlag("net", { description: "With --cloud --sandbox: outbound network profile of the sandbox (none, dev, open; agentbox net)", type: "string" });
	pi.registerFlag("size", { description: "With --cloud --sandbox: size class of the sandbox (small, medium, large; agentbox size)", type: "string" });

	const exposureOf = (name: string) => pi.getAllTools().find((tool) => tool.name === name)?.exposure;

	// Overrides exist only once cloud mode is first enabled, so ordinary
	// sessions keep the engine's own tools; after /cloud off they fall back to
	// fresh local instances. Rebuilt tools get no ctx, so they resolve paths
	// against the remote cwd instead of the local session cwd.
	function registerTools() {
		if (toolsRegistered) return;
		toolsRegistered = true;
		registerPublish(pi, () => target);
		if (role.kind === "child") registerHandoff();
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
		const next = active.filter((name) => !LOCAL_ONLY.test(name));
		// Pushing belongs to the top session; a read-only subagent keeps whatever writers its type lacks.
		const wanted = role.kind === "top" ? ["read", "write", "edit", "publish"] : role.kind === "child" ? ["read", "write", "edit", "handoff"] : ["read"];
		for (const name of wanted) if (!next.includes(name)) next.push(name);
		if (role.kind !== "top") next.splice(0, next.length, ...next.filter((name) => name !== "publish"));
		if (next.length !== active.length || next.some((name, i) => name !== active[i])) pi.setActiveTools(next);
	}

	function show(ctx: ExtensionContext) {
		ctx.ui.setStatus(STATUS, target ? ctx.ui.theme.fg("accent", `cloud: ${describe(target)}`) : undefined);
	}

	// `previous` is the session's last entry; the new target is recorded only when
	// it differs (null records unconditionally).
	async function enable(
		spec: string,
		sandbox: string | true | undefined,
		ctx: ExtensionContext,
		previous: Entry | null | undefined,
		opts: Options = {},
	) {
		const resolved = await resolveTarget(spec, ctx.cwd, sandbox, ctx.sessionManager.getSessionId(), opts);
		target = resolved.target;
		expired = resolved.expired;
		env = resolved.env;
		hostSpec = resolved.spec;
		place = { net: opts.net, size: opts.size };
		failure = undefined;
		// Subagents share a process with their siblings when the task daemon hosts them, so only the
		// top session publishes its target through the environment; children get it from the marker.
		if (role.kind === "top") {
			const publish = (name: string, value: string | undefined) => (value ? (process.env[name] = value) : delete process.env[name]);
			publish(ENV_VARS, env.join(","));
			publish(ENV, resolved.spec);
			publish(ENV_BOX, target.box);
			publish(ENV_NET, opts.net);
			publish(ENV_SIZE, opts.size);
		}
		registerTools();
		applyActiveTools();
		if (previous === null || previous?.spec !== resolved.spec || previous?.sandbox !== target.box) {
			pi.appendEntry(ENTRY, {
				spec: resolved.spec,
				sandbox: target.box,
				...(role.kind === "child" ? { parent: role.parent, branch: role.branch } : {}),
			} satisfies Entry);
		}
		show(ctx);
		if (expired && ctx.hasUI) {
			ctx.ui.notify(`Sandbox ${target.box} had expired and was recreated; its old branches are archived on ${target.dest} in ${expired}.`, "warning");
		}
	}

	function disable(ctx: ExtensionContext) {
		target = undefined;
		expired = undefined;
		env = [];
		failure = undefined;
		delete process.env[ENV];
		delete process.env[ENV_BOX];
		delete process.env[ENV_VARS];
		delete process.env[ENV_NET];
		delete process.env[ENV_SIZE];
		role = { kind: "top" };
		place = {};
		if (savedActive) pi.setActiveTools(savedActive);
		savedActive = undefined;
		pi.appendEntry(ENTRY, { spec: null } satisfies Entry);
		show(ctx);
	}

	async function launch(spec: string, sandbox: string | true | undefined, ctx: ExtensionContext, previous: Entry | null | undefined, build: () => Options) {
		try {
			await enable(spec, sandbox, ctx, previous, build());
			if (target) ctx.ui.notify(`Cloud mode: ${describe(target)}`, "info");
		} catch (error) {
			target = undefined;
			failure = `cloud mode (${spec}) failed to start: ${(error as Error).message}`;
			if (ctx.hasUI) ctx.ui.notify(`${failure} Tools are blocked; fix it with /cloud <host[:path]> or /cloud off.`, "error");
			else console.error(`omo: ${failure}`);
		}
	}

	// Runs at a task child's first prompt. The parent's marker in the prompt names its sandbox; the
	// environment is the fallback for children spawned some other way.
	async function settleChild(identity: ChildIdentity, prompt: string, ctx: ExtensionContext) {
		const fromEnv = (): ParentInfo | undefined => {
			const spec = process.env[ENV];
			return spec
				? { spec, box: process.env[ENV_BOX] ?? "", env: splitVars(process.env[ENV_VARS] ?? ""), net: process.env[ENV_NET], size: process.env[ENV_SIZE], share: false }
				: undefined;
		};
		const parent = parseMarker(prompt) ?? fromEnv();
		if (!parent) return;
		const record = readTaskRecord(identity);
		if (!parent.box) {
			// A plain remote host has one directory for everyone: nothing to split.
			await launch(parent.spec, undefined, ctx, undefined, () => ({ env: parent.env }));
		} else if (parent.share || (record !== undefined && isReadOnly(record))) {
			role = { kind: "shared" };
			await launch(parent.spec, parent.box, ctx, undefined, () => ({}));
		} else {
			const short = shortId(identity.taskId ?? ctx.sessionManager.getSessionId());
			const branch = childBranch(parent.box, short);
			role = { kind: "child", parent: parent.box, branch };
			await launch(parent.spec, childBoxName(parent.box, short), ctx, null, () => ({
				env: parent.env,
				net: checkOption("net", parent.net),
				size: checkOption("size", parent.size),
				from: parent.box,
				branch,
			}));
		}
	}

	// Commits what the subagent left uncommitted and delivers its branches into the parent's clone as
	// sandbox/<box>/*. Serialised, and skipped while no branch moved since the last delivery.
	function handoff(): Promise<string> {
		const deliver = async () => {
			const where = target;
			if (role.kind !== "child" || !where?.box) throw new Error("handoff only works in a subagent's own sandbox.");
			const { box, dest } = where;
			const committed = await run(
				where,
				`cd ${q(where.cwd)} && git add -A && { git diff --cached --quiet || git commit -q -m ${q(`wip: uncommitted work in ${box}`)}; } && git for-each-ref --format='%(refname) %(objectname)' refs/heads`,
			);
			if (committed.code !== 0) throw new Error(`committing leftovers in ${box}: ${committed.stderr.trim() || `exit ${committed.code}`}`);
			const refs = committed.stdout.toString();
			if (refs !== lastRefs) {
				const collected = await run({ dest }, `agentbox collect ${q(box)} --into ${q(role.parent)}`);
				if (collected.code !== 0) throw new Error(`collecting ${box} into ${role.parent}: ${collected.stderr.trim() || `exit ${collected.code}`}`);
				lastRefs = refs;
			}
			return collectedRef(box, role.branch);
		};
		const next = handoffChain.then(deliver, deliver);
		handoffChain = next.catch(() => undefined);
		return next;
	}

	function registerHandoff() {
		pi.registerTool({
			name: "handoff",
			label: "Hand off branch",
			description:
				"Commit uncommitted changes in this sandbox and deliver its branches to the parent's checkout now. This also happens automatically after every turn; call it to be sure before reporting.",
			promptSnippet: "Deliver this subagent sandbox's branches to the parent's checkout",
			parameters: Type.Object({}),
			async execute() {
				const ref = await handoff();
				return { content: [{ type: "text", text: `Delivered to the parent's checkout as ${ref}.` }], details: undefined };
			},
		} as never);
	}

	// A task call from a sandboxed session tells the child which sandbox is its parent, and whether
	// the agent type is read-only. The prompt is the one channel that reaches children however they
	// are hosted: a task daemon shares one process (and environment) between sessions.
	function tagTasks(input: Record<string, unknown>) {
		const where = target;
		if (!where?.box) return;
		const tag = (item: Record<string, unknown>, inherited: Record<string, unknown>) => {
			if (typeof item.prompt !== "string") return;
			const text = (key: string) => (typeof item[key] === "string" ? item[key] : typeof inherited[key] === "string" ? inherited[key] : undefined);
			item.prompt = withMarker(item.prompt, {
				spec: hostSpec,
				box: where.box as string,
				env,
				...place,
				share: isReadOnly({ agentType: text("subagent_type"), category: text("category") }),
			});
		};
		tag(input, {});
		if (Array.isArray(input.tasks)) for (const item of input.tasks) if (item && typeof item === "object") tag(item as Record<string, unknown>, input);
	}

	pi.on("session_start", async (_event, ctx) => {
		const flag = pi.getFlag("cloud");
		const sandboxFlag = pi.getFlag("sandbox");
		const envFlag = pi.getFlag("env");
		// Unset keeps whatever the sandbox already opted into.
		const vars = typeof envFlag === "string" && envFlag ? splitVars(envFlag) : process.env[ENV_VARS] ? splitVars(process.env[ENV_VARS]) : undefined;
		const entry = ctx.sessionManager
			.getBranch()
			.findLast((e) => e.type === "custom" && e.customType === ENTRY) as { data?: Entry } | undefined;
		const identity = typeof flag === "string" && flag ? undefined : childIdentity(ctx);
		if (identity) {
			const data = entry?.data;
			if (data?.spec && data.sandbox && data.parent && data.branch) {
				// A resumed subagent goes back to its own sandbox.
				role = { kind: "child", parent: data.parent, branch: data.branch };
				const { parent, branch } = data;
				await launch(data.spec, data.sandbox, ctx, data, () => ({ from: parent, branch }));
			} else {
				pendingChild = identity;
			}
			return;
		}
		// The flag pair wins, then the inherited environment, then the resumed entry.
		let spec: string | undefined;
		let sandbox: string | true | undefined;
		if (typeof flag === "string" && flag) {
			spec = flag;
			sandbox = sandboxFlag === true ? true : typeof sandboxFlag === "string" && sandboxFlag ? sandboxFlag : undefined;
		} else if (process.env[ENV]) {
			spec = process.env[ENV];
			sandbox = process.env[ENV_BOX] || undefined;
		} else if (entry?.data?.spec) {
			spec = entry.data.spec;
			sandbox = entry.data.sandbox;
		}
		if (!spec) {
			if (sandboxFlag && ctx.hasUI) ctx.ui.notify("--sandbox needs --cloud <host>; tools run locally.", "error");
			return;
		}
		const flagged = (name: string, fallback: string | undefined) => {
			const value = pi.getFlag(name);
			return checkOption(name, typeof value === "string" && value ? value : fallback);
		};
		await launch(spec, sandbox, ctx, entry?.data, () => ({
			env: vars,
			net: flagged("net", process.env[ENV_NET]),
			size: flagged("size", process.env[ENV_SIZE]),
		}));
	});

	pi.registerCommand("cloud", {
		description: "Run this session's tools on a remote host: /cloud <host[:path]> [--sandbox[=name]] [--env=KEY,KEY] [--net PROFILE] [--size CLASS] | off",
		handler: async (args, ctx) => {
			const netOption = takeOption(args.trim().split(/\s+/).filter(Boolean), "net");
			const sizeOption = takeOption(netOption.rest, "size");
			const words = sizeOption.rest;
			const sandboxWord = words.find((word) => word === "--sandbox" || word.startsWith("--sandbox="));
			const envWord = words.find((word) => word.startsWith("--env="));
			const spec = words.filter((word) => word !== sandboxWord && word !== envWord).join(" ");
			const sandbox = sandboxWord ? sandboxWord.slice("--sandbox=".length) || true : undefined;
			if (!spec) {
				ctx.ui.notify(target ? `Cloud mode: ${describe(target)}` : "Cloud mode is off. Usage: /cloud <host[:path]> [--sandbox[=name]]", "info");
				return;
			}
			if (spec === "off") {
				if (target || failure) disable(ctx);
				ctx.ui.notify("Cloud mode off: tools run locally again.", "info");
				return;
			}
			try {
				role = { kind: "top" };
				await enable(spec, sandbox, ctx, null, {
					env: envWord ? splitVars(envWord.slice("--env=".length)) : undefined,
					net: checkOption("net", netOption.value),
					size: checkOption("size", sizeOption.value),
				});
				if (target) ctx.ui.notify(`Cloud mode: ${describe(target)}`, "info");
			} catch (error) {
				ctx.ui.notify(`Cloud mode failed: ${(error as Error).message}`, "error");
			}
		},
	});

	// Model switches can swap edit for apply_patch again; re-assert before each prompt.
	pi.on("before_agent_start", async (event, ctx) => {
		if (pendingChild) {
			const identity = pendingChild;
			pendingChild = undefined;
			await settleChild(identity, event.prompt, ctx);
		}
		if (failure) {
			return { systemPrompt: `${event.systemPrompt}\n\n## Cloud mode\n\nThe user asked for ${failure} Every tool is blocked until they fix it; tell them, and do not try to work locally.` };
		}
		if (!target) return;
		applyActiveTools();
		return { systemPrompt: `${event.systemPrompt}\n\n${promptSection(target, expired, env, role)}` };
	});

	// Tool arguments are cloned before this hook, so the rewrite reaches execution
	// only; the model keeps seeing the command it wrote.
	pi.on("tool_call", (event) => {
		if (failure) return { block: true, reason: `Blocked: ${failure}` };
		if (!target) return;
		if (LOCAL_ONLY.test(event.toolName)) {
			return { block: true, reason: `${event.toolName} is unavailable in cloud mode (${target.dest}); it only works on the local machine.` };
		}
		if (event.toolName === "task") tagTasks(event.input as Record<string, unknown>);
		if (event.toolName === "bash") {
			const input = event.input as { command?: unknown };
			if (typeof input.command === "string") input.command = ptyCommand(target, input.command);
		}
	});

	const deliver = async () => {
		if (role.kind !== "child") return;
		try {
			await handoff();
		} catch (error) {
			console.error(`omo cloud-mode: ${(error as Error).message}`);
		}
	};
	pi.on("agent_end", deliver);
	pi.on("session_shutdown", async (event) => {
		if (event.reason === "quit") await deliver();
	});

	pi.on("user_bash", () => {
		if (failure) return { result: { output: `Blocked: ${failure}`, exitCode: 1, cancelled: false, truncated: false } };
		return target ? { operations: userBashOps(target) } : undefined;
	});
}

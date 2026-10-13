import { StringEnum } from "@earendil-works/pi-ai";
import { type ExtensionAPI, type ExtensionContext, truncateHead } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { type FSWatcher, readFileSync, statSync, watch } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, hostname, tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import { type ConsultantConfig, consult, pickConsultant } from "./consult.ts";
import {
	decideModel,
	decidePlacement,
	decideStrategy,
	type GateEvidence,
	type GateVerdict,
	gateResult,
	MAX_CRITERIA,
	type JevConfig,
	jevApiKey,
	type ModelDecision,
	type PoolEntry,
	type Strategy,
	type StrategyDecision,
} from "./jev.ts";
import { limitPressure, limitsId, spill } from "./limits.ts";
import { appendOutcome, type OutcomeVerdict, outcomeRecord } from "./outcomes.ts";
import {
	defaultPlacement,
	guardPlacement,
	NETS,
	onPath,
	type PlacementChoice,
	type PlacementInput,
	type PlacementMode,
	placementMenu,
	resolveMode,
	SIZES,
	splitVars,
	type WorkersConfig,
} from "./placement.ts";
import { readPriors, summarizePriors } from "./priors.ts";
import { type Exec, fetchBundle, publishRef } from "./publish.ts";
import { harnessInvocation, harnessName, RpcChild, type RpcEvent } from "./rpc.ts";
import {
	boxName,
	bundle,
	type Cloud,
	collect,
	fingerprints as sandboxFingerprints,
	git as sandboxGit,
	leaderCloud,
	leaderPlace,
	localCloud,
	provision,
	workerEnv,
} from "./sandbox.ts";

interface Config {
	// The first model with credentials wins.
	leader: { models: string[]; thinking: string };
	jev: JevConfig;
	fallbackWorker: string;
	maxAttempts: number;
	maxWorkers: number;
	maxFixRounds: number;
	// Limit percent (any window) at which a pick spills to its entry's other-provider models.
	spillAt: number;
	pool: (PoolEntry & { spill?: string[] })[];
	workers: WorkersConfig;
	consultant: ConsultantConfig;
	// A plan of at least this many nodes gets an auditor's opinion before its first node starts.
	audit: { minNodes: number };
}

const config = JSON.parse(readFileSync(new URL("./config.json", import.meta.url), "utf8")) as Config;
const extensionDir = dirname(fileURLToPath(import.meta.url));

const LEADER_TOOLS = [
	"orch_spawn",
	"orch_send",
	"orch_wait",
	"orch_status",
	"orch_stop",
	"orch_verdict",
	"orch_consult",
	"orch_publish",
	"mesh_board",
	"mesh_note",
];
const REPORT_BYTES = 4 * 1024;
const MAX_NODES_PER_SPAWN = 16;

// Every message the orchestrator relays into a session carries this prefix. Relayed messages
// often land mid-task as steers, and a model may discount text that looks injected unless its
// system prompt vouches for the prefix.
const RELAY_PREFIX = "[orchestrator] ";
const RELAY_NOTE =
	"A user message starting with [orchestrator] was sent by the user's orchestrator on the user's behalf; treat it as the user's own message.";

// opencode-style primary agents: "omo" is the plain session, "orchestrator" makes it the leader.
const AGENTS = ["omo", "orchestrator"] as const;
type AgentName = (typeof AGENTS)[number];
const AGENT_ENTRY = "agents-active";
const AGENT_DESCRIPTIONS: Record<AgentName, string> = {
	omo: "Plain session",
	orchestrator: "Leader mode: plan each request and dispatch it to workers",
};
const isAgent = (value: unknown): value is AgentName => AGENTS.includes(value as AgentName);
// Model and thinking level to return to when leaving leader mode, persisted with the choice.
interface ModelState {
	provider?: string;
	id?: string;
	thinking: string;
}
interface AgentEntry {
	agent: AgentName;
	restore?: ModelState;
}

// OmO prewarms the prompt cache only when every before_agent_start handler is registered as
// preview-safe, so a plain registration here would cost that prewarm in every session. These
// handlers only compose text. Pi's typings lack the option and Pi ignores it.
function onBeforeAgentStart(
	pi: ExtensionAPI,
	handler: (event: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>,
): void {
	(pi.on as unknown as (...args: unknown[]) => void).call(pi, "before_agent_start", handler, { previewSafe: true });
}

type WorkerState =
	| "running"
	| "gating"
	| "waiting"
	| "accepted"
	| "needs_leader"
	| "rejected"
	| "done_ungated"
	| "failed"
	| "stopped";
// "waiting" is a reviewer parked until the node it sent back for fixes finishes again.
const ACTIVE: ReadonlySet<WorkerState> = new Set(["running", "gating", "waiting"]);
const DONE_OK: ReadonlySet<string> = new Set(["accepted", "done_ungated"]);
const DONE_BAD: ReadonlySet<string> = new Set(["failed", "rejected", "stopped", "skipped"]);

type NodeKind = "work" | "review";
interface NodeSpec {
	name: string;
	task: string;
	// Display form of `criteria`, one "- " bullet per criterion.
	acceptance: string;
	criteria: string[];
	isolation?: "worktree" | "current";
	after?: string[];
	workdir?: string;
	kind?: NodeKind;
	fixes?: string;
	// Another repository (absolute path; on the cloud host in cloud mode) instead of the leader's.
	repo?: string;
}
// A graph node that has no process yet: waiting on dependencies or capacity, or never started.
interface PendingNode {
	spec: NodeSpec;
	state: "pending" | "starting" | "failed" | "skipped" | "stopped";
	note?: string;
}

interface Peer {
	name: string;
	task: string;
	state: WorkerState;
	model: string;
}

function slugify(value: string): string {
	return (
		value
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 32) || "worker"
	);
}

function splitRef(ref: string): { provider: string; id: string } {
	const slash = ref.indexOf("/");
	return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
}

function clipReport(text: string): string {
	const clipped = truncateHead(text, { maxBytes: REPORT_BYTES, maxLines: 120 });
	return clipped.truncated ? `${clipped.content}\n[report truncated]` : clipped.content;
}

function pct(value: number): string {
	return value.toFixed(2);
}

async function appendBoard(runDir: string, author: string, text: string): Promise<void> {
	await appendFile(join(runDir, "board.md"), `\n## ${author} (${new Date().toISOString()})\n\n${text.trim()}\n`);
}

async function readBoard(runDir: string): Promise<string> {
	return readFile(join(runDir, "board.md"), "utf8").catch(() => "(board is empty)");
}

const BoardNote = Type.Object({
	text: Type.String({ description: "A decision, interface, or finding every agent in the run should see" }),
});

function mailPath(runDir: string, name: string): string {
	return join(runDir, "mail", `${name}.jsonl`);
}

// Leader and worker talk through per-worker JSONL files in the run directory, so the same
// protocol drives a worker whether it runs in a visible Herdr pane or as a hidden RPC child.
// ctl/<name>.jsonl carries leader commands; events/<name>.jsonl carries worker reports.
type Control =
	| { type: "prompt"; message: string }
	| { type: "set_model"; provider: string; modelId: string; thinking: string }
	| { type: "stop" };
type WorkerEvent =
	| { type: "ready"; pid: number; session?: string }
	| { type: "mesh_send"; to: string; message: string }
	| { type: "settled"; text: string; tools: string[] }
	| { type: "exit" };

const TOOL_LOG_LIMIT = 40;

// One line per tool call, e.g. `bash ok: wc -l flake.nix`, as gating evidence.
function summarizeToolCall(name: string, args: unknown, isError: boolean): string {
	const record = (args ?? {}) as Record<string, unknown>;
	const detail = [record.command, record.path, record.code, record.pattern, record.to]
		.find((value): value is string => typeof value === "string")
		?.replace(/\s+/g, " ")
		.slice(0, 160);
	return `${name} ${isError ? "error" : "ok"}${detail ? `: ${detail}` : ""}`;
}

// Accepts a list, or a string with one criterion per line (bullets and numbering stripped).
function toCriteria(acceptance: string | string[]): string[] {
	const items = Array.isArray(acceptance) ? acceptance : acceptance.split("\n");
	const criteria = items.map((item) => item.replace(/^\s*(?:[-*\u2022]|\d+[.)])\s*/, "").trim()).filter(Boolean);
	return criteria.length ? criteria : [String(acceptance).trim()];
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

function channelPath(runDir: string, channel: "ctl" | "events", name: string): string {
	return join(runDir, channel, `${name}.jsonl`);
}

// Returns the complete lines appended since the last call; a partial trailing line waits.
function lineReader(path: string): () => Promise<string[]> {
	let offset = 0;
	return async () => {
		const text = await readFile(path, "utf8").catch(() => "");
		const end = text.lastIndexOf("\n");
		if (end < offset) return [];
		const fresh = text.slice(offset, end);
		offset = end + 1;
		return fresh.split("\n").filter(Boolean);
	};
}

function lastAssistantText(ctx: ExtensionContext): string {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		return entry.message.content
			.flatMap((part) => (part.type === "text" ? [part.text] : []))
			.join("\n")
			.trim();
	}
	return "";
}

function registerWorker(pi: ExtensionAPI) {
	const runDir = process.env.ORCH_RUN_DIR!;
	const self = process.env.ORCH_AGENT!;
	const mesh = process.env.ORCH_MESH === "1";
	let ctx: ExtensionContext | undefined;
	let inMeshWait = false;

	const emit = (event: WorkerEvent) => appendFile(channelPath(runDir, "events", self), `${JSON.stringify(event)}\n`);

	// Starts a turn when idle; otherwise steers the running one. Tasks, leader commands, and
	// mesh mail all pass through here, so this is the one place that adds the relay prefix.
	const deliverPrompt = (message: string) => {
		const text = `${RELAY_PREFIX}${message}`;
		if (!ctx || ctx.isIdle()) pi.sendUserMessage(text);
		else pi.sendUserMessage(text, { deliverAs: "steer" });
	};

	onBeforeAgentStart(pi, async (event) => ({ systemPrompt: `${event.systemPrompt}\n\n${RELAY_NOTE}` }));

	// A worker is always a plain session; leader mode belongs to the session the user drives.
	pi.registerCommand("agent", {
		description: "Switch the primary agent (unavailable in orchestrator workers)",
		handler: async (_args, next) => {
			next.ui.notify("Orchestrator workers always run as omo; leader mode is not available here.", "warning");
		},
	});

	const readControl = lineReader(channelPath(runDir, "ctl", self));
	let controlChain: Promise<void> = Promise.resolve();
	const apply = async (command: Control) => {
		if (command.type === "prompt") deliverPrompt(command.message);
		else if (command.type === "set_model") {
			const model = ctx?.modelRegistry.find(command.provider, command.modelId);
			if (model) await pi.setModel(model);
			pi.setThinkingLevel(command.thinking as Parameters<typeof pi.setThinkingLevel>[0]);
		} else {
			ctx?.abort();
			ctx?.shutdown();
		}
	};
	const pumpControl = () => {
		controlChain = controlChain
			.then(async () => {
				for (const line of await readControl()) await apply(JSON.parse(line) as Control);
			})
			.catch(() => undefined);
	};

	const readPeers = async (): Promise<Peer[]> =>
		(JSON.parse(await readFile(join(runDir, "peers.json"), "utf8")) as Peer[]).filter((peer) => peer.name !== self);

	pi.registerTool({
		name: "mesh_peers",
		label: "Mesh Peers",
		description: "List the other agents in this orchestrated run, with their task, state, and model.",
		parameters: Type.Object({}),
		async execute() {
			const peers = mesh ? await readPeers() : [];
			const lines = peers.map((peer) => `- ${peer.name} [${peer.state}, ${peer.model}]: ${peer.task.slice(0, 200)}`);
			const header = mesh
				? `You are ${self}. Peers:`
				: `You are ${self}. This run is fan-out: only "leader" is reachable.`;
			return { content: [{ type: "text", text: [header, ...lines].join("\n") }], details: undefined };
		},
	});

	pi.registerTool({
		name: "mesh_send",
		label: "Mesh Send",
		description:
			'Send a message to a peer agent, "leader", or "*" (all peers). Use it to agree on shared interfaces or files, report a dependency, or ask the leader for a decision; not for progress chatter.',
		parameters: Type.Object({
			to: Type.String({ description: 'Peer name, "leader", or "*"' }),
			message: Type.String(),
		}),
		async execute(_id, params) {
			if (params.to !== "leader") {
				if (!mesh) throw new Error('This run is fan-out: only "leader" is reachable.');
				const names = (await readPeers()).map((peer) => peer.name);
				if (params.to !== "*" && !names.includes(params.to)) {
					throw new Error(`Unknown peer "${params.to}". Known: leader, *, ${names.join(", ")}`);
				}
			}
			await emit({ type: "mesh_send", to: params.to, message: params.message });
			return { content: [{ type: "text", text: `Sent to ${params.to}.` }], details: undefined };
		},
	});

	const readMail = lineReader(mailPath(runDir, self));
	const takeMail = async (): Promise<string[]> =>
		(await readMail()).map((line) => {
			const mail = JSON.parse(line) as { from: string; message: string };
			return `[mesh from ${mail.from}] ${mail.message}`;
		});
	// Mail that arrives outside mesh_wait is delivered as a prompt; inside it, the wait returns it.
	let mailChain: Promise<void> = Promise.resolve();
	const pumpMail = () => {
		if (inMeshWait) return;
		mailChain = mailChain
			.then(async () => {
				if (inMeshWait) return;
				const mail = await takeMail();
				if (mail.length) deliverPrompt(mail.join("\n"));
			})
			.catch(() => undefined);
	};

	pi.registerTool({
		name: "mesh_wait",
		label: "Mesh Wait",
		description:
			"Block until a peer or the leader messages you, or the timeout passes. Call it instead of ending your turn when you need a reply: ending your turn submits your final report.",
		parameters: Type.Object({
			timeout_seconds: Type.Optional(Type.Number({ minimum: 1, maximum: 1800, default: 300 })),
		}),
		async execute(_id, params, signal) {
			const deadline = Date.now() + (params.timeout_seconds ?? 300) * 1000;
			inMeshWait = true;
			await mailChain;
			try {
				let mail = await takeMail();
				while (mail.length === 0 && Date.now() < deadline && !signal?.aborted) {
					await new Promise<void>((resolve) => {
						const watcher = watch(join(runDir, "mail"), () => finish());
						const timer = setTimeout(finish, deadline - Date.now());
						signal?.addEventListener("abort", finish, { once: true });
						function finish() {
							watcher.close();
							clearTimeout(timer);
							resolve();
						}
					});
					mail = await takeMail();
				}
				const text = mail.length ? mail.join("\n") : "No messages before the timeout.";
				return { content: [{ type: "text", text }], details: undefined };
			} finally {
				inMeshWait = false;
				pumpMail();
			}
		},
	});

	const watchers: FSWatcher[] = [];
	pi.on("session_start", async (_event, next) => {
		ctx = next;
		pi.events.emit("agents:active", { agent: "omo" });
		if (watchers.length === 0) {
			watchers.push(watch(join(runDir, "ctl"), pumpControl), watch(join(runDir, "mail"), pumpMail));
			// The session file lets the outcome log point at this worker's transcript.
			await emit({ type: "ready", pid: process.pid, session: next.sessionManager.getSessionFile() });
		}
		// The leader queues the task before launch; start it once the session is up.
		setImmediate(() => {
			pumpControl();
			pumpMail();
		});
	});
	const toolArgs = new Map<string, unknown>();
	let toolLog: string[] = [];
	pi.on("agent_start", async () => {
		toolLog = [];
	});
	pi.on("tool_execution_start", async (event) => {
		toolArgs.set(event.toolCallId, event.args);
	});
	pi.on("tool_execution_end", async (event) => {
		toolLog.push(summarizeToolCall(event.toolName, toolArgs.get(event.toolCallId), event.isError));
		toolArgs.delete(event.toolCallId);
	});
	pi.on("agent_settled", async (_event, next) => {
		ctx = next;
		await emit({ type: "settled", text: lastAssistantText(next), tools: toolLog.slice(-TOOL_LOG_LIMIT) });
	});
	pi.on("session_shutdown", async () => {
		for (const watcher of watchers.splice(0)) watcher.close();
		await emit({ type: "exit" });
	});

	pi.registerTool({
		name: "mesh_board",
		label: "Mesh Board",
		description: "Read the shared blackboard of decisions and findings for this run.",
		parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text", text: await readBoard(runDir) }], details: undefined };
		},
	});

	pi.registerTool({
		name: "mesh_note",
		label: "Mesh Note",
		description: "Append a decision, interface, or finding to the shared blackboard.",
		parameters: BoardNote,
		async execute(_id, params) {
			await appendBoard(runDir, self, params.text);
			return { content: [{ type: "text", text: "Noted on the board." }], details: undefined };
		},
	});
}

interface Resolved {
	entry: PoolEntry;
	ref: string;
	// The entry's first other-provider model with credentials.
	spill?: string;
}

interface Worker {
	name: string;
	task: string;
	acceptance: string;
	criteria: string[];
	// HEAD and the `git status` lines at spawn with a size:mtime fingerprint of each file, so
	// evidence shows only this worker's changes, including further edits to already-dirty files.
	start: { head?: string; root?: string; dirty: Map<string, string> };
	// Clear Jev misses since the last (re)open; a repeat miss escalates the model.
	misses: number;
	cwd: string;
	branch?: string;
	worktree?: string;
	// Set when the checkout is on the cloud host (leader in cloud mode): inside `box`, or the
	// leader's host directory without one. `isolated` is false only for the shared checkout.
	cloud?: Cloud;
	box?: string;
	isolated: boolean;
	placement: PlacementMode;
	placementNote: string;
	// The sandbox's limits; for a shared checkout, those of the sandbox it shares.
	net?: string;
	size?: string;
	env?: string[];
	// Local repository root for host worktrees and this machine's sandboxes.
	repoRoot?: string;
	attemptStart: number;
	session?: string;
	// Refs last fetched from the worker's sandbox into the leader's repo.
	collected?: string;
	current: Resolved;
	modelNote: string;
	history: string[];
	attempts: number;
	state: WorkerState;
	// Hidden RPC child outside Herdr; inside Herdr the worker runs in `pane` instead.
	child?: RpcChild;
	pane?: string;
	pid?: number;
	report: string;
	verdict?: GateVerdict;
	gateNote?: string;
	mailbox: string[];
	kind: NodeKind;
	after: string[];
	fixes?: string;
	fixRounds: number;
	// Set while this node works through a reviewer's findings; that reviewer judges the result.
	fixingFor?: string;
	// Reopening resets attempts, so report files use their own counter to keep every round.
	reports: number;
}

interface Run {
	id: string;
	dir: string;
	goal?: string;
	planAudited: boolean;
	strategy: Strategy;
	strategyNote: string;
	workers: Map<string, Worker>;
	nodes: Map<string, PendingNode>;
	pool: Resolved[];
	inbox: string[];
	waiters: Set<() => void>;
	waiting: number;
}

function workerPrompt(
	name: string,
	run: Run,
	spec: NodeSpec,
	isolated: boolean,
	sandboxBranch?: string,
	ownSandbox = false,
): string {
	const mesh = run.strategy === "mesh";
	const { acceptance } = spec;
	const repo = spec.repo
		? `Your checkout is the repository at ${spec.repo}, not the leader's: work there, and branch from its own HEAD.`
		: undefined;
	const sandbox = sandboxBranch
		? spec.kind === "review"
			? `You work in the agentbox sandbox of "${spec.workdir}", on its branch \`${sandboxBranch}\`, which holds the work under review.`
			: spec.workdir && !ownSandbox
				? `You work in the agentbox sandbox of "${spec.workdir}", on its branch \`${sandboxBranch}\`, which already holds its work. Build on it and commit on that branch (never push): only commits leave the sandbox.`
				: spec.workdir
					? `You work in your own agentbox sandbox, on branch \`${sandboxBranch}\` cut from the last commit of "${spec.workdir}", so it starts with that node's work. Commit your work on that branch as you go (never push): only commits leave the sandbox, and the orchestrator collects them for the leader when you finish.`
					: `You work in your own agentbox sandbox, on branch \`${sandboxBranch}\` cut from the leader's commit. Commit your work on that branch as you go (never push): only commits leave the sandbox, and the orchestrator collects them for the leader when you finish.`
		: undefined;
	const checkout = sandbox ?? (spec.workdir
		? `You work in the Git worktree of "${spec.workdir}", which already holds its uncommitted changes. Build on them; do not create another worktree and do not commit.`
		: isolated
			? "You work in a dedicated Git worktree. Do not create another worktree and do not commit."
			: "You work in the shared checkout. Do not commit.");
	const review =
		spec.kind === "review"
			? [
					"You are a reviewer: do not edit files. Check the work in your checkout against the acceptance criteria and run whatever validation proves it.",
					"The last line of your final report must be exactly `VERDICT: PASS` or `VERDICT: FAIL`. On FAIL, list concrete, actionable findings above it; they are sent back for fixing.",
				]
			: [];
	return [
		`You are worker "${name}" in an orchestrated team. A leader agent split the goal and gave you one subtask.`,
		checkout,
		...(repo ? [repo] : []),
		...review,
		mesh
			? "Peers work in parallel on related subtasks. Use mesh_peers to see them, mesh_send to agree on shared interfaces or files, and mesh_note/mesh_board for decisions everyone needs."
			: 'Your subtask is independent. Use mesh_send to "leader" only if you need a decision.',
		"Messages from peers or the leader arrive as user messages starting with [orchestrator] [mesh from <name>], or as mesh_wait results starting with [mesh from <name>].",
		"Ending your turn submits your final report. If you need a reply first, call mesh_wait.",
		`Acceptance criteria:\n${acceptance}`,
		"End with a final report: what you did, changed files, how you validated it, and anything blocking.",
		"Your turn is judged one criterion at a time against the checkout's actual changes and the commands you ran. For each criterion, state the evidence that shows it holds, and say plainly what is not done.",
	].join("\n");
}

// What the plan auditor sees: the goal and the whole graph, as the leader wrote it.
function planContext(run: Run, specs: NodeSpec[]): string {
	const nodes = specs.map((spec) =>
		[
			`## ${spec.name} (${spec.kind ?? "work"}${spec.isolation === "current" ? ", shared checkout" : ""})`,
			spec.after?.length ? `After: ${spec.after.join(", ")}` : undefined,
			spec.workdir ? `Works in the checkout of: ${spec.workdir}` : undefined,
			spec.fixes ? `Sends FAIL findings to: ${spec.fixes}` : undefined,
			spec.repo ? `Repository: ${spec.repo}` : undefined,
			`Task: ${spec.task}`,
			`Acceptance:\n${spec.acceptance}`,
		]
			.filter((line): line is string => line !== undefined)
			.join("\n"),
	);
	return [`Goal:\n${run.goal ?? "(not recorded)"}`, `Strategy: ${run.strategy}. ${run.strategyNote}`, ...nodes].join("\n\n");
}

function registerLeader(pi: ExtensionAPI) {
	let run: Run | undefined;
	let lastCtx: ExtensionContext | undefined;
	// Decided once per leader process: sandboxes need agentbox on this host and OmO's cloud-mode.
	const placementMode = resolveMode(config.workers.placement, onPath("agentbox"), harnessName());

	const changed = () => {
		if (!run) return;
		for (const resolve of run.waiters) resolve();
		run.waiters.clear();
		void writePeers();
		pi.events.emit("orchestrator:state", {
			id: run.id,
			strategy: run.strategy,
			workers: [
				...[...run.workers.values()].map((worker) => ({
					name: worker.name,
					state: worker.state,
					model: worker.current.ref,
				})),
				...[...run.nodes.values()].map((node) => ({ name: node.spec.name, state: node.state, model: "" })),
			],
		});
	};

	const stateOf = (r: Run, name: string): string | undefined => r.workers.get(name)?.state ?? r.nodes.get(name)?.state;
	const isActive = (state: string | undefined) =>
		state === "pending" || state === "starting" || ACTIVE.has(state as WorkerState);
	const anyActive = (r: Run): boolean =>
		[...r.workers.values(), ...r.nodes.values()].some((item) => isActive(item.state));

	const notifyLeader = (text: string) => {
		if (!run || run.waiting > 0 || !lastCtx) return;
		pi.sendUserMessage(`${RELAY_PREFIX}${text}`, lastCtx.isIdle() ? undefined : { deliverAs: "followUp" });
	};

	const toInbox = (line: string) => {
		if (!run) return;
		run.inbox.push(line);
		changed();
		notifyLeader(`${line}\nUse orch_wait or orch_status to see the run.`);
	};

	const writePeers = async () => {
		if (!run) return;
		const peers: Peer[] = [...run.workers.values()].map((worker) => ({
			name: worker.name,
			task: worker.task,
			state: worker.state,
			model: worker.current.ref,
		}));
		await writeFile(join(run.dir, "peers.json"), JSON.stringify(peers, null, 2));
	};

	const resolvePool = (ctx: ExtensionContext): Resolved[] =>
		config.pool.flatMap((entry) => {
			const usable = (candidate: string): boolean => {
				const { provider, id } = splitRef(candidate);
				const model = ctx.modelRegistry.find(provider, id);
				return model !== undefined && ctx.modelRegistry.hasConfiguredAuth(model);
			};
			const ref = entry.models.find(usable);
			const spill = ref ? entry.spill?.find((candidate) => limitsId(candidate) !== limitsId(ref) && usable(candidate)) : undefined;
			return ref ? [{ entry, ref, ...(spill ? { spill } : {}) }] : [];
		});

	// Keeps the preferred provider until its limits run hot, then moves the pick to the other
	// provider's model of the same entry, if that one has headroom.
	const spillOver = (choice: Resolved): { choice: Resolved; note: string } => {
		const picked = spill(choice.ref, choice.spill, config.spillAt, (ref) => limitPressure(ref));
		if (picked.hot === undefined) return { choice, note: "" };
		return {
			choice: { entry: choice.entry, ref: picked.ref },
			note: ` ${limitsId(choice.ref)} limits at ${Math.round(picked.hot)}%, so it runs on ${picked.ref}.`,
		};
	};

	const escalation = (current: Resolved, pool: Resolved[]): Resolved => {
		const provider = splitRef(current.ref).provider;
		const higher = pool.filter((option) => option.entry.tier > current.entry.tier);
		const minTier = Math.min(...higher.map((option) => option.entry.tier));
		const next = higher.filter((option) => option.entry.tier === minTier);
		return next.find((option) => splitRef(option.ref).provider === provider) ?? next[0] ?? current;
	};

	const startRun = async (strategy: Strategy, strategyNote: string, goal?: string): Promise<Run> => {
		const id = randomUUID().slice(0, 8);
		const dir = join(tmpdir(), "pi-orch", id);
		for (const sub of ["mail", "ctl", "events", "launch"]) await mkdir(join(dir, sub), { recursive: true });
		await writeFile(join(dir, "board.md"), `# Orchestration ${id}\n\nStrategy: ${strategy}. ${strategyNote}\n`);
		run = {
			id,
			dir,
			goal,
			planAudited: false,
			strategy,
			strategyNote,
			workers: new Map(),
			nodes: new Map(),
			pool: [],
			inbox: [],
			waiters: new Set(),
			waiting: 0,
		};
		await writePeers();
		watchEvents(run);
		return run;
	};

	const control = (worker: Worker, command: Control) =>
		appendFile(channelPath(run!.dir, "ctl", worker.name), `${JSON.stringify(command)}\n`);

	// Outcome log (C2). A failed write is reported once, never retried, and never stops the run.
	let outcomeLogFailed = false;
	const recordOutcome = (
		worker: Worker,
		verdict: OutcomeVerdict,
		attempt: number,
		startedAt: number,
		scores?: { criterion: string; p: number }[],
	) => {
		if (!run) return;
		const record = outcomeRecord({
			now: Date.now(),
			host: hostname(),
			harness: harnessName(),
			run: run.id,
			node: worker.name,
			kind: worker.kind,
			task: worker.task,
			criteria: worker.criteria,
			repo: worker.repoRoot ?? worker.cloud?.hostDir ?? worker.start.root,
			placement: {
				mode: worker.placement,
				box: worker.placement === "worktree" ? undefined : worker.box,
				net: worker.net,
				size: worker.size,
			},
			model: {
				key: worker.current.entry.key,
				ref: worker.current.ref,
				thinking: worker.current.entry.thinking,
				tier: worker.current.entry.tier,
			},
			pickNote: worker.modelNote,
			attempt,
			verdict,
			scores,
			acceptThreshold: config.jev.acceptThreshold,
			startedAt,
			workerSession: worker.session,
			leaderSession: lastCtx?.sessionManager.getSessionFile(),
		});
		appendOutcome(record).catch((error: Error) => {
			if (outcomeLogFailed) return;
			outcomeLogFailed = true;
			toInbox(`Writing the outcome log failed: ${error.message} (later failures in this session are not reported).`);
		});
	};

	const markExited = (worker: Worker, note: string) => {
		if (!ACTIVE.has(worker.state)) return;
		if (worker.state === "running") recordOutcome(worker, "failed", worker.attempts, worker.attemptStart);
		worker.state = "failed";
		worker.gateNote = note;
		changed();
		void schedule();
	};

	// One watcher per run feeds every worker's events file through its own reader, in order.
	let eventsWatcher: FSWatcher | undefined;
	let livenessTimer: ReturnType<typeof setInterval> | undefined;
	const readers = new Map<string, () => Promise<string[]>>();
	let eventsChain: Promise<void> = Promise.resolve();
	const watchEvents = (r: Run) => {
		eventsWatcher?.close();
		readers.clear();
		const pump = () => {
			eventsChain = eventsChain
				.then(async () => {
					for (const worker of r.workers.values()) {
						let read = readers.get(worker.name);
						if (!read) readers.set(worker.name, (read = lineReader(channelPath(r.dir, "events", worker.name))));
						for (const line of await read()) onEvent(worker, JSON.parse(line) as WorkerEvent);
					}
				})
				.catch(() => undefined);
		};
		eventsWatcher = watch(join(r.dir, "events"), pump);
		// A pane worker that dies without a clean shutdown sends no exit event.
		if (livenessTimer) clearInterval(livenessTimer);
		livenessTimer = setInterval(() => {
			for (const worker of r.workers.values()) {
				if (!worker.pane || !worker.pid || !ACTIVE.has(worker.state)) continue;
				try {
					process.kill(worker.pid, 0);
				} catch {
					markExited(worker, `Worker process ${worker.pid} in pane ${worker.pane} is gone.`);
				}
			}
		}, 15_000);
		livenessTimer.unref?.();
	};

	const onEvent = (worker: Worker, event: WorkerEvent) => {
		if (event.type === "ready") {
			worker.pid = event.pid;
			worker.session = event.session;
		}
		else if (event.type === "mesh_send") route(worker.name, event.to, event.message);
		else if (event.type === "settled") void onSettled(worker, run!.pool, event.text, event.tools ?? []);
		else markExited(worker, "Worker process exited.");
	};

	const decideRunStrategy = async (goal: string, ctx: ExtensionContext, signal?: AbortSignal) => {
		if (!jevApiKey()) {
			return {
				strategy: "mesh" as Strategy,
				note: "Jev unavailable (TYPESAFE_API_KEY unset): defaulted to mesh, unrestricted.",
				decision: undefined,
			};
		}
		let decision: StrategyDecision;
		try {
			decision = await decideStrategy(config.jev, goal, signal);
		} catch (error) {
			return {
				strategy: "mesh" as Strategy,
				note: `Jev failed (${(error as Error).message}): defaulted to mesh, unrestricted.`,
				decision: undefined,
			};
		}
		let strategy = decision.strategy;
		let note = `Jev chose ${strategy} (confidence ${pct(decision.confidence)}; p=${JSON.stringify(decision.probabilities)}).`;
		if (decision.confidence < config.jev.strategyConfidence && ctx.hasUI && process.env.OMO_UNSUPERVISED !== "1") {
			const options = ["solo", "fan_out", "mesh"];
			const picked = await ctx.ui.select(
				`Jev is unsure (confidence ${pct(decision.confidence)}, leaning ${strategy}). How should the team run?`,
				options,
			);
			if (picked && picked !== strategy) {
				strategy = picked as Strategy;
				note += ` The user overrode it to ${strategy}.`;
			}
		} else if (decision.confidence < config.jev.strategyConfidence) {
			note += " Low confidence and no UI to confirm; kept Jev's top choice.";
		}
		return { strategy, note, decision };
	};

	const pickModel = async (
		task: string,
		acceptance: string,
		pool: Resolved[],
		signal?: AbortSignal,
	): Promise<{ choice: Resolved; note: string }> => {
		const fallback = pool.find((option) => option.entry.key === config.fallbackWorker) ?? pool[0];
		if (!jevApiKey()) {
			const spilled = spillOver(fallback);
			return { choice: spilled.choice, note: `Jev unavailable (TYPESAFE_API_KEY unset); fallback model.${spilled.note}` };
		}
		let decision: ModelDecision;
		try {
			const priors = await readPriors();
			decision = await decideModel(
				config.jev,
				pool.map((option) => option.entry),
				{ task, acceptance, strategy: run!.strategy },
				signal,
				priors && summarizePriors(priors, pool.map((option) => option.entry.key)),
			);
		} catch (error) {
			const spilled = spillOver(fallback);
			return { choice: spilled.choice, note: `Jev failed (${(error as Error).message}); fallback model.${spilled.note}` };
		}
		const picked = pool.find((option) => option.entry.key === decision.key) ?? fallback;
		const { choice, note: spillNote } = spillOver(picked);
		const unsure = decision.escalated ? " Unsure between its top two, so the higher tier won." : "";
		return { choice, note: `Jev chose ${choice.entry.key} (confidence ${pct(decision.confidence)}).${unsure}${spillNote}` };
	};

	// Catalog variables a worker's sandbox may get: in cloud mode the leader's own opt-ins,
	// otherwise the configured list. Neither Jev nor the defaults go beyond it.
	const allowedEnv = (): string[] =>
		leaderCloud() ? splitVars(process.env.OMO_CLOUD_ENV) : Object.keys(config.workers.envAllowed);

	const pickPlacement = async (
		spec: NodeSpec,
		input: PlacementInput,
		signal?: AbortSignal,
	): Promise<PlacementChoice & { note: string }> => {
		const allowed = allowedEnv();
		const menu = placementMenu(input);
		const fallback = defaultPlacement(input, config.workers, allowed);
		// Net, size, and env only matter for a new sandbox; without one there is nothing to ask.
		if (!menu.includes("sandbox")) return { ...fallback, note: "" };
		if (!jevApiKey()) return { ...fallback, note: "Default placement (Jev unavailable)." };
		try {
			const decision = await decidePlacement(
				config.jev,
				{
					modes: menu,
					nets: NETS.filter((net) => net !== "open" || config.workers.allowOpenNet),
					sizes: [...SIZES],
					env: Object.fromEntries(allowed.map((key) => [key, config.workers.envAllowed[key] ?? `the sandbox catalog variable ${key}`])),
				},
				{ task: spec.task, acceptance: spec.acceptance, kind: spec.kind ?? "work" },
				signal,
			);
			const { overridden, ...choice } = guardPlacement(decision, input, config.workers, allowed);
			const refused = overridden.length ? ` Guardrails refused ${overridden.join("; ")}.` : "";
			return { ...choice, note: `Placement by Jev.${refused}` };
		} catch (error) {
			return { ...fallback, note: `Jev placement failed (${(error as Error).message}); default placement.` };
		}
	};

	const reopen = (target: Worker, text: string) => {
		target.state = "running";
		target.attempts = 1;
		target.misses = 0;
		target.attemptStart = Date.now();
		changed();
		control(target, { type: "prompt", message: text }).catch((error: Error) => markExited(target, error.message));
	};

	const deliver = (target: Worker, from: string, message: string) => {
		const text = `[mesh from ${from}] ${message}`;
		// The worker delivers its own mail: into mesh_wait when it is waiting, else as a steer.
		if (target.state === "running") {
			appendFile(mailPath(run!.dir, target.name), `${JSON.stringify({ from, message })}\n`).catch((error: Error) => {
				toInbox(`Delivery to ${target.name} failed: ${error.message}`);
			});
		} else if (target.state === "gating") {
			target.mailbox.push(text);
		} else if (from === "leader" && target.state !== "failed" && target.state !== "stopped") {
			target.fixingFor = undefined;
			reopen(target, text);
		} else {
			toInbox(`Undelivered ${from} -> ${target.name} (${target.state}): ${message}`);
		}
	};

	const route = (from: string, to: string, message: string) => {
		if (!run) return;
		if (to === "leader") {
			toInbox(`${from} says: ${message}`);
			return;
		}
		const targets = to === "*" ? [...run.workers.values()].filter((worker) => worker.name !== from) : [run.workers.get(to)];
		for (const target of targets) if (target) deliver(target, from, message);
	};

	const git = async (cwd: string, args: string[]): Promise<string | undefined> => {
		const result = await pi.exec("git", args, { cwd, timeout: 10_000 });
		return result.code === 0 ? result.stdout.trim() : undefined;
	};

	const clipLines = (text: string, limit = 60): string => {
		const lines = text.split("\n");
		return lines.length > limit ? [...lines.slice(0, limit), `(+${lines.length - limit} more)`].join("\n") : text;
	};

	// A checkout on the cloud host is reached over SSH (inside its sandbox, if any).
	type Where = { cwd: string; box?: string; cloud?: Cloud };
	const gitAt = (where: Where, args: string[]) => (where.cloud ? sandboxGit(where.cloud, where, args) : git(where.cwd, args));

	// Porcelain paths are relative to the repository root, quoted when unusual, and renames
	// read `old -> new`.
	const porcelainPath = (line: string): string => line.slice(3).split(" -> ").pop()!.replace(/^"|"$/g, "");

	const fingerprints = async (where: Where, root: string, lines: string[]): Promise<string[]> => {
		if (where.cloud) return sandboxFingerprints(where.cloud, where, root, lines.map(porcelainPath));
		return lines.map((line) => {
			try {
				const stat = statSync(join(root, porcelainPath(line)));
				return `${stat.size}:${stat.mtimeMs}`;
			} catch {
				return "missing";
			}
		});
	};

	const snapshot = async (where: Where): Promise<Worker["start"]> => {
		const root = await gitAt(where, ["rev-parse", "--show-toplevel"]);
		const status = (await gitAt(where, ["status", "--porcelain=v1", "--untracked-files=all"])) ?? "";
		const lines = status.split("\n").filter(Boolean);
		const prints = root ? await fingerprints(where, root, lines) : [];
		return {
			head: await gitAt(where, ["rev-parse", "HEAD"]),
			root,
			dirty: new Map(lines.map((line, index) => [line, prints[index] ?? ""])),
		};
	};

	const collectEvidence = async (worker: Worker, tools: string[]): Promise<GateEvidence> => {
		const { dirty, root, head } = worker.start;
		const status = (await gitAt(worker, ["status", "--porcelain=v1", "--untracked-files=all"])) ?? "(git status failed)";
		const lines = status.split("\n").filter(Boolean);
		const again = lines.filter((line) => dirty.has(line));
		const prints = root ? await fingerprints(worker, root, again) : [];
		const edited = new Set(again.filter((line, index) => root && dirty.get(line) !== prints[index]));
		const changed = lines.flatMap((line) =>
			!dirty.has(line) ? [line] : edited.has(line) ? [`${line} (already dirty at start, changed since)`] : [],
		);
		const commits = head ? await gitAt(worker, ["log", "--oneline", `${head}..HEAD`]) : undefined;
		// Sandbox workers commit as they go, so their diff starts at the commit they began from.
		const base = worker.box && worker.isolated && head ? head : "HEAD";
		return {
			changed_files: changed.length ? clipLines(changed.join("\n")) : "(no uncommitted changes since the worker started)",
			diff_stat: clipLines((await gitAt(worker, ["diff", "--stat", base])) || "(none)"),
			commits_since_start: head ? commits || "(none)" : "(unknown)",
			tool_calls: tools.join("\n") || "(none)",
		};
	};

	// Turns the user starts by typing into a finished worker's pane settle outside "running"
	// and are not gated.
	const onSettled = async (worker: Worker, pool: Resolved[], text: string, tools: string[]) => {
		if (worker.state !== "running" || !run) return;
		worker.state = "gating";
		changed();
		const attempt = worker.attempts;
		const startedAt = worker.attemptStart;
		let evidence: GateEvidence | undefined;
		worker.report = text;
		worker.reports++;
		await writeFile(join(run.dir, `${worker.name}.report-${worker.reports}.md`), worker.report);
		const r = run;
		const finish = async () => {
			if (worker.kind === "work" && worker.box && worker.isolated && worker.cloud) {
				try {
					worker.collected = await collect(worker.cloud, worker, worker.name);
				} catch (error) {
					toInbox(`Collecting ${worker.name}'s branch from sandbox ${worker.box} failed: ${(error as Error).message}`);
				}
			}
			for (const pending of worker.mailbox.splice(0)) toInbox(`Undelivered to ${worker.name} (${worker.state}): ${pending}`);
			changed();
			await schedule();
			if (worker.state === "needs_leader") {
				toInbox(`${worker.name} needs a decision. ${worker.gateNote}`);
				auditDecision(worker, evidence);
			} else if (!anyActive(r)) notifyLeader("All workers have finished. Call orch_wait to collect their results.");
		};

		// A reviewer's own VERDICT line decides; FAIL sends its findings back to the node it
		// reviews and parks the reviewer until that node settles again.
		if (worker.kind === "review") {
			const verdict = /VERDICT:\s*(PASS|FAIL)\W*$/i.exec(worker.report.trim())?.[1]?.toUpperCase();
			const target = worker.fixes ? r.workers.get(worker.fixes) : undefined;
			if (verdict === "PASS") {
				worker.state = "accepted";
				worker.gateNote = `Review passed${worker.fixRounds ? ` after ${worker.fixRounds} fix round(s)` : ""}.`;
			} else if (verdict === "FAIL" && target && worker.fixRounds < config.maxFixRounds && !DONE_BAD.has(target.state)) {
				worker.fixRounds++;
				worker.state = "waiting";
				worker.gateNote = `Review failed; fix round ${worker.fixRounds}/${config.maxFixRounds} sent to ${target.name}.`;
				target.fixingFor = worker.name;
				reopen(
					target,
					`[review from ${worker.name}] Fix these findings, validate the result, and give a new final report:\n${clipReport(worker.report)}`,
				);
			} else if (verdict === "FAIL") {
				worker.state = "rejected";
				worker.gateNote = target ? `Review still failing after ${worker.fixRounds} fix round(s).` : "Review failed.";
			} else {
				worker.state = "needs_leader";
				worker.gateNote = "Review report has no VERDICT line. Answer with orch_send to resume it.";
			}
			recordOutcome(worker, worker.state === "waiting" ? "retry" : (worker.state as OutcomeVerdict), attempt, startedAt);
			await finish();
			return;
		}

		// Jev would grade a fix round against the node's original acceptance; the reviewer that
		// asked for the fixes re-reviews instead.
		if (worker.fixingFor) {
			worker.state = "accepted";
			worker.gateNote = `Fix round submitted; ${worker.fixingFor} re-reviews it.`;
			worker.fixingFor = undefined;
			recordOutcome(worker, "accepted", attempt, startedAt);
			await finish();
			return;
		}

		let verdict: GateVerdict | undefined;
		if (!jevApiKey()) {
			worker.gateNote = "Jev unavailable (TYPESAFE_API_KEY unset); result not gated.";
		} else {
			try {
				evidence = await collectEvidence(worker, tools);
				verdict = await gateResult(config.jev, worker, worker.report, evidence);
			} catch (error) {
				worker.gateNote = `Jev gate failed (${(error as Error).message}); result not gated.`;
			}
		}
		worker.verdict = verdict;

		// A clear miss (some criterion under borderlineFloor) is retried with the failing criteria,
		// on the same model first and a stronger one on a repeat miss. Borderline results get one
		// retry, then go to the leader instead of being rejected, so dependents wait.
		const failing = verdict?.criteria.filter((criterion) => criterion.p < config.jev.acceptThreshold) ?? [];
		const clearMiss = failing.some((criterion) => criterion.p < config.jev.borderlineFloor);
		const failingText = failing.map((criterion) => `- ${criterion.criterion} (p=${pct(criterion.p)})`).join("\n");
		const warning =
			verdict && verdict.unrelatedChanges >= 0.5
				? ` Warning: changed files may be unrelated to the task (p=${pct(verdict.unrelatedChanges)}).`
				: "";
		if (!verdict) {
			worker.state = "done_ungated";
		} else if (verdict.blocked >= config.jev.blockedThreshold) {
			worker.state = "needs_leader";
			worker.gateNote = `Jev: blocked (p=${pct(verdict.blocked)}). Answer with orch_send to resume it, or decide with orch_verdict.${warning}`;
		} else if (failing.length === 0) {
			worker.state = "accepted";
			worker.gateNote = `Jev: all ${verdict.criteria.length} criteria met.${warning}`;
		} else if (!clearMiss && worker.attempts >= 2) {
			worker.state = "needs_leader";
			worker.gateNote = `Jev is unsure about:\n${failingText}\nDecide with orch_verdict, or reopen it with orch_send.${warning}`;
		} else if (worker.attempts < config.maxAttempts) {
			const next = clearMiss && worker.misses > 0 ? escalation(worker.current, pool) : worker.current;
			if (clearMiss) worker.misses++;
			try {
				if (next.ref !== worker.current.ref) {
					const { provider, id } = splitRef(next.ref);
					await control(worker, { type: "set_model", provider, modelId: id, thinking: next.entry.thinking });
					worker.history.push(`${worker.current.entry.key} -> ${next.entry.key}`);
					worker.current = next;
				}
				worker.attempts++;
				worker.state = "running";
				worker.gateNote = `Jev: ${failing.length} criteria not shown; retry ${worker.attempts} on ${next.entry.key}.${warning}`;
				const feedback = [
					"These acceptance criteria are not yet shown to hold:",
					failingText,
					"Finish what is missing, validate it, and give a new final report with the evidence for each criterion.",
					...worker.mailbox.splice(0),
				].join("\n");
				changed();
				await control(worker, { type: "prompt", message: feedback });
				recordOutcome(worker, "retry", attempt, startedAt, verdict.criteria);
				worker.attemptStart = Date.now();
				return;
			} catch (error) {
				worker.state = "failed";
				worker.gateNote = `Retry failed: ${(error as Error).message}`;
			}
		} else {
			worker.state = "rejected";
			worker.gateNote = `Jev: still not met after ${worker.attempts} attempts:\n${failingText}\norch_verdict can overrule this.${warning}`;
		}

		recordOutcome(worker, worker.state as OutcomeVerdict, attempt, startedAt, verdict?.criteria);
		await finish();
	};

	// The auditor: a consultant whose opinion lands in front of the leader and is never acted on.
	const consultations = new Set<AbortController>();
	const askConsultant = async (
		question: string,
		context: string,
		ctx: ExtensionContext,
		signal?: AbortSignal,
	): Promise<{ ref: string; note: string; text: string }> => {
		const usable = (ref: string): boolean => {
			const { provider, id } = splitRef(ref);
			const model = ctx.modelRegistry.find(provider, id);
			return model !== undefined && ctx.modelRegistry.hasConfiguredAuth(model);
		};
		const picked = pickConsultant(config.consultant.models, usable, (ref) => limitPressure(ref), config.spillAt);
		if (!picked) throw new Error(`no consultant model has credentials (${config.consultant.models.join(", ")})`);
		const controller = new AbortController();
		const abort = () => controller.abort();
		signal?.addEventListener("abort", abort, { once: true });
		consultations.add(controller);
		try {
			const text = await consult({
				ref: picked.ref,
				thinking: config.consultant.thinking,
				tools: config.consultant.tools,
				cwd: ctx.cwd,
				question,
				context,
				timeoutMs: config.consultant.timeoutSeconds * 1000,
				signal: controller.signal,
			});
			return { ...picked, text };
		} finally {
			consultations.delete(controller);
			signal?.removeEventListener("abort", abort);
		}
	};

	const auditDecision = (worker: Worker, evidence: GateEvidence | undefined) => {
		const ctx = lastCtx;
		if (!ctx) return;
		const context = [
			`Node "${worker.name}" (${worker.kind}) of an orchestrated run. Its task:\n${worker.task}`,
			`Acceptance criteria:\n${worker.acceptance}`,
			`Gate result: ${worker.gateNote ?? "(none)"}`,
			worker.verdict
				? `Jev's per-criterion probabilities (pass at ${config.jev.acceptThreshold}):\n${worker.verdict.criteria.map((c) => `- ${pct(c.p)} ${c.criterion}`).join("\n")}`
				: undefined,
			evidence
				? `Evidence the orchestrator collected:\nChanged files:\n${evidence.changed_files}\nDiff stat:\n${evidence.diff_stat}\nCommits:\n${evidence.commits_since_start}\nTool calls:\n${evidence.tool_calls}`
				: undefined,
			`Checkout: ${worker.box ? `sandbox ${worker.box}, branch ${worker.branch}` : worker.worktree ?? worker.cwd}`,
			`Worker's final report:\n${clipReport(worker.report)}`,
		]
			.filter((part): part is string => part !== undefined)
			.join("\n\n");
		const question =
			"The gate could not decide this worker's result, so the leader must. Should the leader accept it, reopen it with specific instructions (say which), or reject it? Judge each criterion against the evidence, not the report's claims.";
		askConsultant(question, context, ctx).then(
			(answer) => toInbox(`Auditor on ${worker.name} (${answer.ref}; advisory, nothing was changed):${answer.note ? ` ${answer.note}` : ""}\n${answer.text}`),
			(error: Error) => toInbox(`Auditor on ${worker.name} unavailable: ${error.message}`),
		);
	};

	// Starts every pending node whose dependencies all finished, skips nodes behind a failed
	// dependency, and resumes reviewers whose fix round settled. Calls are serialized.
	let scheduling: Promise<void> = Promise.resolve();
	const schedule = (): Promise<void> => (scheduling = scheduling.then(runSchedule, runSchedule));
	const runSchedule = async (): Promise<void> => {
		const r = run;
		const ctx = lastCtx;
		if (!r || !ctx) return;
		let progressed = true;
		while (progressed) {
			progressed = false;
			for (const reviewer of r.workers.values()) {
				if (reviewer.state !== "waiting" || !reviewer.fixes) continue;
				const target = stateOf(r, reviewer.fixes);
				if (target && DONE_OK.has(target)) {
					reopen(reviewer, `${reviewer.fixes} addressed your findings. Review again and end with a VERDICT line.`);
					progressed = true;
				} else if (target && DONE_BAD.has(target)) {
					reviewer.state = "rejected";
					reviewer.gateNote = `${reviewer.fixes} ended ${target} during fix round ${reviewer.fixRounds}.`;
					progressed = true;
				}
			}
			for (const [name, node] of r.nodes) {
				if (node.state !== "pending") continue;
				const deps = node.spec.after ?? [];
				const bad = deps.find((dep) => DONE_BAD.has(stateOf(r, dep) ?? "failed"));
				if (bad) {
					node.state = "skipped";
					node.note = `Dependency ${bad} ended ${stateOf(r, bad)}.`;
					progressed = true;
					continue;
				}
				if (!deps.every((dep) => DONE_OK.has(stateOf(r, dep) ?? ""))) continue;
				const running = [...r.workers.values()].filter((worker) => worker.state === "running" || worker.state === "gating");
				if (running.length >= config.maxWorkers) break;
				const home = node.spec.workdir ? r.workers.get(node.spec.workdir)?.cwd : undefined;
				if (home && running.some((worker) => worker.cwd === home)) continue;
				if (node.spec.isolation === "current" && running.some((worker) => !worker.isolated)) continue;
				node.state = "starting";
				try {
					await spawnWorker(node.spec, ctx, r.pool);
					r.nodes.delete(name);
				} catch (error) {
					node.state = "failed";
					node.note = (error as Error).message;
					toInbox(`${name} failed to start: ${node.note}`);
				}
				progressed = true;
			}
		}
		changed();
	};

	const herdr = async (args: string[], cwd: string, signal?: AbortSignal): Promise<string> => {
		const result = await pi.exec("herdr", args, { cwd, signal });
		if (result.code !== 0) {
			// Herdr reports API errors as JSON on stdout, not stderr.
			let reason = result.stderr.trim();
			try {
				reason ||= (JSON.parse(result.stdout) as { error?: { message?: string } }).error?.message ?? "";
			} catch {
				reason ||= result.stdout.trim();
			}
			throw new Error(`herdr ${args.slice(0, 2).join(" ")} failed${reason ? `: ${reason}` : ""}`);
		}
		return result.stdout;
	};
	const herdrJson = async <T>(args: string[], cwd: string, signal?: AbortSignal): Promise<T> =>
		(JSON.parse(await herdr(args, cwd, signal)) as { result: T }).result;

	const spawnWorker = async (spec: NodeSpec, ctx: ExtensionContext, pool: Resolved[], signal?: AbortSignal): Promise<Worker> => {
		const r = run!;
		const name = slugify(spec.name);
		const upstream = spec.workdir ? r.workers.get(spec.workdir) : undefined;
		const inHerdr = process.env.HERDR_ENV === "1";
		const leader = leaderCloud();
		const upstreamSandbox = !!(upstream?.box && upstream.isolated && upstream.cloud);
		const input: PlacementInput = {
			kind: spec.kind ?? "work",
			isolated: (spec.isolation ?? "worktree") === "worktree",
			upstream: upstream ? { sandbox: upstreamSandbox } : undefined,
			leaderCloud: leader !== undefined,
			mode: placementMode.mode,
		};
		const [{ choice, note }, placed] = await Promise.all([
			pickModel(spec.task, spec.acceptance, pool, signal),
			pickPlacement(spec, input, signal),
		]);

		// A sandbox lives on the leader's cloud host when the leader runs in cloud mode, else on
		// this machine, seeded from the repository itself. Either way the worker process stays
		// local (and visible) with cloud-mode pointing its tools there. A node on another
		// repository is seeded from that repository and collected back into it, never into the
		// leader's checkout or sandbox.
		const origin = upstream ? ctx.cwd : (spec.repo ?? ctx.cwd);
		const toplevel = async (dir: string): Promise<string> => {
			const root = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd: dir, signal });
			if (root.code !== 0) throw new Error('worktree isolation needs a Git repository; use isolation "current"');
			return root.stdout.trim();
		};
		let cwd = origin;
		let cloud: Cloud | undefined;
		let isolated = true;
		let branch: string | undefined;
		let worktree: string | undefined;
		let box: string | undefined;
		let pane: string | undefined;
		let repoRoot: string | undefined;
		let limits: { net?: string; size?: string; env?: string[] } = {};
		if (placed.mode === "shared" && upstream) {
			({ cwd, branch, worktree, box, cloud, isolated, repoRoot } = upstream);
			limits = { net: upstream.net, size: upstream.size, env: upstream.env };
		} else if (placed.mode === "shared") {
			isolated = false;
			// A host-side leader's shared node is a plain local worker without OMO_CLOUD, so
			// destructive-guard keeps checking it like the leader itself.
			if (leader) {
				if (spec.repo) throw new Error(`${name}: a node with \`repo\` in cloud mode needs worktree isolation (its own sandbox)`);
				cloud = leader;
				({ cwd, box } = await leaderPlace(cloud, signal));
			}
		} else if (placed.mode === "sandbox") {
			if (upstream?.cloud) cloud = upstream.cloud;
			else if (leader) cloud = spec.repo ? { dest: leader.dest, hostDir: spec.repo } : leader;
			else cloud = localCloud((repoRoot = await toplevel(origin)));
			repoRoot ??= upstream?.repoRoot;
			branch = `orch/${r.id}-${name}`;
			box = boxName(r.id, name);
			limits = { net: placed.net, size: placed.size, env: placed.env };
			const from = upstream?.box && upstreamSandbox ? { cwd: upstream.cwd, box: upstream.box } : undefined;
			({ cwd } = await provision(cloud, box, branch, limits, signal, from));
			if (inHerdr) {
				// Without --workspace Herdr picks the focused one, which with a second client
				// attached (an SSH login) need not be the leader's.
				const workspace = process.env.HERDR_WORKSPACE_ID;
				const created = await herdrJson<{ root_pane: { pane_id: string } }>(
					["tab", "create", ...(workspace ? ["--workspace", workspace] : []), "--cwd", ctx.cwd, "--label", `orch ${name}`, "--no-focus"],
					ctx.cwd,
					signal,
				);
				pane = created.root_pane.pane_id;
			}
		} else {
			const repo = await toplevel(origin);
			repoRoot = repo;
			branch = `orch/${r.id}-${name}`;
			// Herdr-managed worktrees keep checkouts out of the repo's parent directory and show
			// up grouped under the repo workspace, whose root pane then hosts the worker. Outside
			// Herdr, mirror its default layout so `herdr worktree open` can adopt the checkout later.
			if (inHerdr) {
				// Herdr only creates worktrees from the repo's main checkout and resolves --base there,
				// so a leader inside a linked worktree passes the main checkout and its own commit.
				const [listed, head] = await Promise.all([
					pi.exec("git", ["worktree", "list", "--porcelain"], { cwd: repo, signal }),
					pi.exec("git", ["rev-parse", "HEAD"], { cwd: repo, signal }),
				]);
				const main = /^worktree (.+)$/m.exec(listed.stdout)?.[1];
				if (listed.code !== 0 || head.code !== 0 || !main) {
					throw new Error((listed.stderr || head.stderr).trim() || "cannot resolve the main checkout or HEAD");
				}
				const base = head.stdout.trim();
				const created = await herdrJson<{ worktree: { path: string }; root_pane: { pane_id: string } }>(
					["worktree", "create", "--cwd", main, "--branch", branch, "--base", base, "--label", `orch ${name}`, "--no-focus"],
					repo,
					signal,
				);
				worktree = created.worktree.path;
				pane = created.root_pane.pane_id;
			} else {
				worktree = join(homedir(), ".herdr", "worktrees", basename(repo), branch.replaceAll("/", "-"));
				const added = await pi.exec("git", ["worktree", "add", "-b", branch, worktree, "HEAD"], { cwd: repo, signal });
				if (added.code !== 0) throw new Error(added.stderr.trim() || "git worktree add failed");
			}
			cwd = join(worktree, relative(repo, origin));
		}
		// Nodes sharing an upstream checkout split its pane; shared-checkout nodes split the leader's.
		// A remote host's paths do not exist here, so a cloud worker runs locally from the leader's cwd.
		const localCwd = cloud ? (cloud.dest === "local" ? origin : ctx.cwd) : cwd;
		if (inHerdr && !pane) {
			const anchor = upstream?.pane ?? process.env.HERDR_PANE_ID;
			const direction = upstream?.pane ? "right" : "down";
			const split = await herdrJson<{ pane: { pane_id: string } }>(
				["pane", "split", ...(anchor ? ["--pane", anchor] : []), "--direction", direction, "--cwd", localCwd, "--no-focus"],
				localCwd,
				signal,
			);
			pane = split.pane.pane_id;
		}

		// Taken before launch, so nothing the worker does can land in its own baseline.
		const start = await snapshot({ cwd, box, cloud });
		const { provider, id } = splitRef(choice.ref);
		const env: Record<string, string> = { ORCH_ROLE: "worker", ORCH_AGENT: name, ORCH_RUN_DIR: r.dir, ORCH_MESH: r.strategy === "mesh" ? "1" : "0" };
		// destructive-guard treats this run-owned checkout as the worker's scratch space.
		if (worktree) env.ORCH_WORKTREE = worktree;
		// Started from a `/unsupervised` run (destructive-guard sets it): nobody answers this worker either.
		const unsupervised = process.env.OMO_UNSUPERVISED === "1";
		if (unsupervised) env.OMO_UNSUPERVISED = "1";
		if (cloud) Object.assign(env, workerEnv(cloud, box, limits.env));
		const args = [
			"--approve",
			"--provider",
			provider,
			"--model",
			id,
			"--thinking",
			choice.entry.thinking,
			// Pi and OmO load this alongside the installed package without conflict; it keeps
			// workers working when the leader itself loaded the extension with -e.
			"--extension",
			extensionDir,
			"--exclude-tools",
			"worktree_agents",
		];
		const prompt = [
			workerPrompt(name, r, spec, isolated, cloud && isolated ? branch : undefined, placed.mode === "sandbox"),
			unsupervised
				? 'The user is away for this run and nobody answers dialogs or questions. Take the option you would recommend and note it in your report; only the leader (mesh_send "leader") can decide for you. A command the destructive guard refuses was not run: skip that step and report it.'
				: undefined,
		]
			.filter((part): part is string => part !== undefined)
			.join("\n");
		// The worker extension reads its first task from the control file once its session is up.
		await writeFile(channelPath(r.dir, "ctl", name), `${JSON.stringify({ type: "prompt", message: spec.task } satisfies Control)}\n`);

		let child: RpcChild | undefined;
		if (pane) {
			const promptFile = join(r.dir, "launch", `${name}.prompt.md`);
			const script = join(r.dir, "launch", `${name}.sh`);
			const command = harnessInvocation(args);
			await writeFile(promptFile, prompt);
			await writeFile(
				script,
				[
					"#!/bin/sh",
					`cd ${shellQuote(localCwd)} || exit 1`,
					...Object.entries(env).map(([key, value]) => `export ${key}=${shellQuote(value)}`),
					`exec ${[command.command, ...command.args].map(shellQuote).join(" ")} --append-system-prompt "$(cat ${shellQuote(promptFile)})"`,
					"",
				].join("\n"),
			);
			// The label is cosmetic: a failed rename must not cost the worker.
			await herdr(["pane", "rename", pane, `orch ${name}`], localCwd, signal).catch((error: Error) => {
				toInbox(`${name}: ${error.message}; its pane keeps its default label.`);
			});
			// The pane's own shell runs the script, so the pane returns to a prompt when the worker exits.
			// `cwd` may be a path inside a sandbox, which does not exist here.
			await herdr(["pane", "run", pane, `sh ${shellQuote(script)}`], localCwd, signal);
		} else {
			child = new RpcChild(["--no-session", ...args, "--append-system-prompt", prompt], localCwd, env);
		}

		const worker: Worker = {
			name,
			task: spec.task,
			acceptance: spec.acceptance,
			criteria: spec.criteria,
			start,
			misses: 0,
			cwd,
			branch,
			worktree,
			cloud,
			box,
			isolated,
			placement: placed.mode,
			placementNote: placed.note,
			...limits,
			repoRoot,
			attemptStart: Date.now(),
			current: choice,
			modelNote: note,
			history: [],
			attempts: 1,
			state: "running",
			child,
			pane,
			report: "",
			mailbox: [],
			kind: spec.kind ?? "work",
			after: spec.after ?? [],
			fixes: spec.fixes,
			fixRounds: 0,
			reports: 0,
		};
		r.workers.set(name, worker);

		if (child) {
			const rpc = child;
			rpc.onEvent((event: RpcEvent) => {
				if (event.type === "extension_ui_request" && ["confirm", "select", "input", "editor"].includes(event.method as string)) {
					relayDialog(rpc, name, event);
				}
			});
			void rpc.exited.then((code) => markExited(worker, `Worker process exited (${code}): ${rpc.stderr().slice(-1000)}`));
		}
		changed();
		return worker;
	};

	const stopWorker = async (worker: Worker) => {
		await control(worker, { type: "stop" }).catch(() => undefined);
		await worker.child?.stop();
	};

	const describe = (worker: Worker, withReport: boolean): string => {
		const lines = [
			`### ${worker.name} — ${worker.state}`,
			`Model: ${worker.current.ref} (${worker.modelNote}${worker.history.length ? ` Escalated: ${worker.history.join(", ")}.` : ""})`,
			`Attempts: ${worker.attempts}. ${worker.gateNote ?? ""}`,
			worker.verdict
				? `Jev criteria: ${worker.verdict.criteria
						.map((criterion, index) => `${criterion.p >= config.jev.acceptThreshold ? "pass" : "fail"} #${index + 1} (${pct(criterion.p)})`)
						.join(", ")}`
				: undefined,
			worker.box && worker.isolated
				? `Sandbox: ${worker.box} on ${worker.cloud?.dest}${worker.net || worker.size ? ` (net ${worker.net ?? "?"}, size ${worker.size ?? "?"}, env ${worker.env?.join(", ") || "none"})` : ""}\nBranch: ${worker.branch}${worker.collected ? `\nCollected into your repo: ${worker.collected.split("\n").join(", ")}` : ""}`
				: worker.worktree
					? `Worktree: ${worker.worktree}\nBranch: ${worker.branch}`
					: `Checkout: ${worker.cwd}${worker.cloud ? ` on ${worker.cloud.dest}${worker.box ? ` (sandbox ${worker.box})` : ""}` : ""}`,
			worker.placementNote ? `Placement: ${worker.placement}. ${worker.placementNote}` : undefined,
			worker.pane ? `Herdr pane: ${worker.pane}` : undefined,
		];
		if (worker.after.length) lines.splice(1, 0, `After: ${worker.after.join(", ")}`);
		if (withReport && worker.report) lines.push("", clipReport(worker.report));
		return lines.filter((line): line is string => line !== undefined).join("\n");
	};

	const describeNode = (node: PendingNode): string =>
		[
			`### ${node.spec.name} — ${node.state}${node.spec.kind === "review" ? " (review)" : ""}`,
			node.spec.after?.length ? `After: ${node.spec.after.join(", ")}` : undefined,
			node.spec.workdir ? `Runs in ${node.spec.workdir}'s checkout.` : undefined,
			node.note,
		]
			.filter((line): line is string => line !== undefined)
			.join("\n");

	const describeName = (r: Run, name: string, withReport: boolean): string => {
		const worker = r.workers.get(name);
		return worker ? describe(worker, withReport) : describeNode(r.nodes.get(name)!);
	};

	// Hidden RPC workers have no UI of their own, so their dialogs wait for a client answer.
	// The leader is that client: it shows each dialog to the user, one at a time. Pane
	// workers show dialogs in their own pane.
	let dialogs: Promise<void> = Promise.resolve();
	const relayDialog = (child: RpcChild, name: string, event: RpcEvent) => {
		const id = event.id as string;
		dialogs = dialogs
			.then(async () => {
				const ctx = lastCtx;
				const title = `[worker ${name}] ${String(event.title ?? "")}`;
				let response: Record<string, unknown> = { cancelled: true };
				if (ctx?.hasUI && event.method === "confirm") {
					response = { confirmed: await ctx.ui.confirm(title, String(event.message ?? "")) };
				} else if (ctx?.hasUI && event.method === "select" && Array.isArray(event.options)) {
					const value = await ctx.ui.select(title, event.options as string[]);
					if (value !== undefined) response = { value };
				}
				child.write({ type: "extension_ui_response", id, ...response });
			})
			.catch(() => child.write({ type: "extension_ui_response", id, cancelled: true }));
	};

	const requireRun = (): Run => {
		if (!run) throw new Error("No orchestration run. Start one with /orchestrate <goal> or orch_spawn.");
		return run;
	};

	const applyLeaderModel = async (ctx: ExtensionContext) => {
		const candidates = process.env.ORCH_LEADER_MODEL ? [process.env.ORCH_LEADER_MODEL] : config.leader.models;
		const leaderRef =
			candidates.find((candidate) => {
				const model = ctx.modelRegistry.find(splitRef(candidate).provider, splitRef(candidate).id);
				return model !== undefined && ctx.modelRegistry.hasConfiguredAuth(model);
			}) ?? candidates[0];
		const { provider, id } = splitRef(leaderRef);
		const leaderModel = ctx.modelRegistry.find(provider, id);
		if (!leaderModel) {
			ctx.ui.notify(`Leader model ${leaderRef} is not in the catalog; keeping the current model.`, "warning");
		} else if (ctx.model?.provider !== provider || ctx.model?.id !== id) {
			if (!(await pi.setModel(leaderModel))) {
				ctx.ui.notify(`No credentials for ${leaderRef}; keeping the current model.`, "warning");
			}
		}
		pi.setThinkingLevel(config.leader.thinking as Parameters<typeof pi.setThinkingLevel>[0]);
	};

	const activateLeaderTools = () => pi.setActiveTools([...new Set([...pi.getActiveTools(), ...LEADER_TOOLS])]);

	const PLANS: Record<Strategy, string> = {
		solo: "Do the work yourself; orch_spawn is disabled for this run.",
		fan_out:
			"Split the goal into independent subtasks and spawn one worker per subtask. Workers cannot talk to each other, only to you.",
		mesh: "Split the goal into parallel subtasks that may share interfaces or files. Workers coordinate directly through mesh messages and the shared board.",
	};
	const LEAD_GUIDE = [
		"How to lead:",
		"- Give each worker a self-contained task and a list of concrete, checkable acceptance criteria. Jev picks each worker's model and judges every criterion separately against the checkout's real changes and the commands the worker ran.",
		"- A clear miss is retried with the failing criteria (same model first, a stronger one on a repeat miss). A borderline result after a retry, or a blocked worker, becomes needs_leader and its dependents wait: decide it with orch_verdict, or reopen it with orch_send. orch_verdict also overrules a Jev rejection.",
		"- Record shared decisions with mesh_note before spawning, so workers start aligned.",
		"- Call orch_wait to block until workers finish or one of them messages you; answer with orch_send. orch_send to a finished worker reopens it with new instructions.",
		"- Plan the work as a graph, not a flat list: orch_spawn accepts the whole graph at once. `after` makes a node wait until the named nodes are accepted, and the orchestrator starts it then (dependents of a failed node are skipped). `workdir` runs a node in an upstream node's worktree so it builds on those uncommitted changes.",
		'- Add `kind: "review"` nodes for verification and code review, with `workdir` and `after` set to the node under review. With `fixes` naming that node, a `VERDICT: FAIL` sends the findings back to it and the reviewer re-checks once it settles, up to ' +
			`${config.maxFixRounds} rounds. Make later nodes depend on the reviewer, not the reviewed node, so they start only on a passing review.`,
		`- Placement: ${placementMode.note} In cloud mode isolated workers get sandboxes on your cloud host. Jev picks each sandbox's network (none, dev, or open only when allowed), size, and catalog variables from a fixed menu, and may put a node in a host worktree instead; review nodes always share the checkout they review.`,
		"- A sandbox worker is branched from your last commit (commit first: uncommitted changes do not reach it). It commits there, and when it finishes its branches are fetched into your repo as `sandbox/<sandbox>/<branch>` (orch_status shows them); merge from those. Worktree workers do not commit: review and integrate their worktrees yourself, then validate the integrated result.",
		`- orch_consult asks a stronger reasoning model (Fable, or GPT-6 Astra when Claude's limits run hot) one question with the context you give it; use it for hard design calls and when you doubt a plan or result. An auditor also reviews any plan of ${config.audit.minNodes} or more nodes before its first node starts, and every needs_leader result. Its opinions are advice: weigh them, you decide.`,
		"- orch_publish pushes an accepted node's branch to origin under a name you pick by the repository's conventions (never the default branch, never forced) and can open a draft PR. Publish only when the goal asks for a push or PR.",
	];
	// The /orchestrate brief without a goal: in leader mode the user's next requests are the goal.
	const LEADER_MODE_PROMPT = [
		"Orchestrator mode: you are the leader of an orchestrated agent team. Treat each user request as a goal for the team: plan it and dispatch it with orch_spawn instead of implementing it yourself. Answer plain questions and status checks directly.",
		"The first orch_spawn or mesh_note after a new request starts a new run, and Jev picks its execution strategy from the request:",
		...Object.entries(PLANS).map(([strategy, plan]) => `- ${strategy}: ${plan}`),
		"If the request is ambiguous, ask the user what is unclear before spawning workers.",
		"",
		...LEAD_GUIDE,
	].join("\n");

	// Primary agent. Requests typed in leader mode since the last run started form the next goal,
	// so a clarifying answer joins the request it clarifies.
	let agent: AgentName = "omo";
	let restore: ModelState | undefined;
	let nextGoal: string | undefined;

	// A new request in leader mode starts a new run, as /orchestrate does for its goal; a run whose
	// workers are still active is kept so the request extends it.
	const ensureRun = async (ctx: ExtensionContext, signal?: AbortSignal, fallbackGoal?: string): Promise<Run> => {
		const goal = nextGoal ?? (run ? undefined : fallbackGoal);
		nextGoal = undefined;
		if (goal === undefined || (run && anyActive(run))) return requireRun();
		const { strategy, note } = await decideRunStrategy(goal, ctx, signal);
		return startRun(strategy, note, goal);
	};

	const restoreModel = async (ctx: ExtensionContext, saved: ModelState) => {
		const model = saved.provider && saved.id ? ctx.modelRegistry.find(saved.provider, saved.id) : undefined;
		if (model && !(await pi.setModel(model))) {
			ctx.ui.notify(`No credentials for ${saved.provider}/${saved.id}; keeping the current model.`, "warning");
		}
		pi.setThinkingLevel(saved.thinking as Parameters<typeof pi.setThinkingLevel>[0]);
	};

	const switchAgent = async (next: AgentName, ctx: ExtensionContext) => {
		lastCtx = ctx;
		if (next === agent) {
			ctx.ui.notify(`Agent: ${agent} (already active)`, "info");
			return;
		}
		if (next === "orchestrator") {
			restore = { provider: ctx.model?.provider, id: ctx.model?.id, thinking: pi.getThinkingLevel() };
			await applyLeaderModel(ctx);
			activateLeaderTools();
		} else {
			if (restore) await restoreModel(ctx, restore);
			restore = undefined;
			nextGoal = undefined;
			// Active workers still report to this session, so it keeps the tools to manage them.
			if (!run || !anyActive(run)) pi.setActiveTools(pi.getActiveTools().filter((name) => !LEADER_TOOLS.includes(name)));
		}
		agent = next;
		pi.appendEntry(AGENT_ENTRY, { agent, restore } satisfies AgentEntry);
		pi.events.emit("agents:active", { agent });
		const model = `${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "no model"} (${pi.getThinkingLevel()})`;
		ctx.ui.notify(
			agent === "orchestrator"
				? `Agent: orchestrator on ${model}. Your next request is planned and dispatched to workers.`
				: `Agent: omo on ${model}.`,
			"info",
		);
	};

	// Cycle events can arrive back to back; each switch must see the previous one's result.
	let switching: Promise<void> = Promise.resolve();
	const requestSwitch = (target: AgentName | undefined, ctx: ExtensionContext): Promise<void> =>
		(switching = switching
			.then(() => switchAgent(target ?? AGENTS[(AGENTS.indexOf(agent) + 1) % AGENTS.length], ctx))
			.catch((error: Error) => ctx.ui.notify(`Agent switch failed: ${error.message}`, "error")));

	pi.registerFlag("agent", {
		description: `Initial primary agent for new sessions: ${AGENTS.join(" or ")}`,
		type: "string",
	});

	pi.registerCommand("agent", {
		description: "Switch the primary agent: omo (plain session) or orchestrator (leader mode); no argument cycles",
		getArgumentCompletions: (prefix) => {
			const items = AGENTS.filter((name) => name.startsWith(prefix.trim())).map((name) => ({
				value: name,
				label: name,
				description: AGENT_DESCRIPTIONS[name],
			}));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const name = args.trim();
			if (name && !isAgent(name)) {
				ctx.ui.notify(`Unknown agent "${name}". Agents: ${AGENTS.join(", ")}.`, "warning");
				return;
			}
			await requestSwitch(name || undefined, ctx);
		},
	});

	pi.on("input", async (event) => {
		if (agent !== "orchestrator" || event.source === "extension" || event.streamingBehavior === "steer") return;
		nextGoal = nextGoal ? `${nextGoal}\n\n${event.text}` : event.text;
	});

	onBeforeAgentStart(pi, async (event) => {
		const additions = [
			agent === "orchestrator" ? LEADER_MODE_PROMPT : undefined,
			agent === "orchestrator" || run ? RELAY_NOTE : undefined,
		].filter((part): part is string => part !== undefined);
		return additions.length ? { systemPrompt: [event.systemPrompt, ...additions].join("\n\n") } : undefined;
	});

	let unsubscribeCycle: (() => void) | undefined;
	pi.on("session_start", async (event, ctx) => {
		lastCtx = ctx;
		const saved = ctx.sessionManager
			.getEntries()
			.findLast((entry) => entry.type === "custom" && entry.customType === AGENT_ENTRY);
		const data = saved?.type === "custom" ? (saved.data as AgentEntry | undefined) : undefined;
		agent = "omo";
		restore = undefined;
		if (data && isAgent(data.agent)) {
			// The session restores its own model and thinking level; only the mode needs rebuilding.
			agent = data.agent;
			restore = data.restore;
			if (agent === "orchestrator") activateLeaderTools();
		} else if (event.reason === "startup" || event.reason === "new") {
			const flag = pi.getFlag("agent");
			if (isAgent(flag)) {
				if (flag !== agent) await requestSwitch(flag, ctx);
			} else if (flag) ctx.ui.notify(`Unknown --agent "${flag}"; expected ${AGENTS.join(" or ")}.`, "warning");
		}
		unsubscribeCycle ??= pi.events.on("agents:cycle", () => {
			if (lastCtx) void requestSwitch(undefined, lastCtx);
		});
		pi.events.emit("agents:active", { agent });
	});

	pi.on("session_shutdown", async () => {
		unsubscribeCycle?.();
		unsubscribeCycle = undefined;
		if (livenessTimer) clearInterval(livenessTimer);
		eventsWatcher?.close();
		for (const consultation of consultations) consultation.abort();
		if (!run) return;
		await Promise.all([...run.workers.values()].map(stopWorker));
	});

	pi.registerCommand("orchestrate", {
		description: "Run a goal with a Jev-directed leader and worker mesh",
		handler: async (args, ctx) => {
			lastCtx = ctx;
			const goal = args.trim();
			if (!goal) {
				ctx.ui.notify("Usage: /orchestrate <goal>", "warning");
				return;
			}
			if (run && anyActive(run)) {
				ctx.ui.notify("Workers are still running. Use orch_stop before starting a new run.", "warning");
				return;
			}

			await applyLeaderModel(ctx);
			// This goal owns the new run; requests typed earlier in leader mode must not replace it.
			nextGoal = undefined;
			const { strategy, note, decision } = await decideRunStrategy(goal, ctx);
			const started = await startRun(strategy, note, goal);
			activateLeaderTools();

			const brief = [
				"You are the leader of an orchestrated agent team.",
				`Goal: ${goal}`,
				"",
				`Execution strategy: ${strategy}. ${note}`,
				decision && decision.needsClarification >= 0.5
					? `Jev rates the goal as ambiguous (p=${pct(decision.needsClarification)}): ask the user what is unclear before spawning workers.`
					: undefined,
				PLANS[strategy],
				"",
				...LEAD_GUIDE,
				`Run directory: ${started.dir}`,
			]
				.filter((line): line is string => line !== undefined)
				.join("\n");
			pi.sendUserMessage(brief, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
		},
	});

	pi.registerTool({
		name: "orch_spawn",
		label: "Orchestrator: Spawn Workers",
		description:
			"Add a graph of worker nodes to the current orchestration. Nodes without unmet `after` dependencies start now (up to the concurrency limit); the rest start as their dependencies are accepted. Jev picks each node's model and gates work nodes; review nodes decide by their VERDICT line. Returns immediately; use orch_wait for results.",
		promptSnippet: "Spawn a dependency graph of Jev-routed worker and review nodes",
		defaultActive: false,
		parameters: Type.Object({
			workers: Type.Array(
				Type.Object({
					name: Type.String({ description: "Short unique node name" }),
					task: Type.String({ description: "Self-contained subtask" }),
					acceptance: Type.Union([Type.Array(Type.String(), { minItems: 1, maxItems: MAX_CRITERIA }), Type.String()], {
						description: `Concrete, checkable acceptance criteria, ideally a list (at most ${MAX_CRITERIA}); Jev judges each one separately`,
					}),
					isolation: Type.Optional(
						StringEnum(["worktree", "current"] as const, {
							description:
								'Default "worktree": its own checkout, an agentbox sandbox where sandboxes are available (Jev may choose a host worktree instead), else a Git worktree. "current" shares the caller checkout; such nodes run one at a time.',
						}),
					),
					after: Type.Optional(
						Type.Array(Type.String(), { description: "Nodes (this batch or earlier) that must be accepted before this one starts" }),
					),
					workdir: Type.Optional(
						Type.String({ description: "Run in this upstream node's checkout instead of a new worktree; must be in `after`" }),
					),
					kind: Type.Optional(
						StringEnum(["work", "review"] as const, {
							description: 'Default "work". "review" nodes do not edit files and end with VERDICT: PASS or VERDICT: FAIL.',
						}),
					),
					fixes: Type.Optional(
						Type.String({ description: "Review nodes only: the node in `after` that a FAIL verdict reopens with the findings" }),
					),
					repo: Type.Optional(
						Type.String({
							description:
								"Absolute path of a different Git repository this node works on (on the sandbox host in cloud mode), branched from its own HEAD; default: the leader's checkout. Not with `workdir`.",
						}),
					),
				}),
				{ minItems: 1, maxItems: MAX_NODES_PER_SPAWN },
			),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			lastCtx = ctx;
			const r = await ensureRun(ctx, signal, params.workers.map((worker) => `- ${worker.task}`).join("\n"));
			if (r.strategy === "solo") {
				throw new Error(`${r.strategyNote} Do the work yourself, or start a new /orchestrate run if the plan changed.`);
			}
			const specs: NodeSpec[] = params.workers.map((worker) => {
				if (worker.repo && (!worker.repo.startsWith("/") || worker.workdir)) {
					throw new Error(`${worker.name}: \`repo\` must be an absolute path and cannot be combined with \`workdir\`.`);
				}
				const criteria = toCriteria(worker.acceptance);
				if (criteria.length > MAX_CRITERIA) {
					throw new Error(`${worker.name}: ${criteria.length} acceptance criteria; merge them into at most ${MAX_CRITERIA}.`);
				}
				return {
					...worker,
					acceptance: criteria.map((criterion) => `- ${criterion}`).join("\n"),
					criteria,
					name: slugify(worker.name),
					after: (worker.after ?? []).map(slugify),
					// A reviewer judges the checkout it reviews, so one with `fixes` but no `workdir` gets it.
					workdir: worker.workdir
						? slugify(worker.workdir)
						: worker.kind === "review" && worker.fixes
							? slugify(worker.fixes)
							: undefined,
					fixes: worker.fixes ? slugify(worker.fixes) : undefined,
				};
			});
			const names = specs.map((spec) => spec.name);
			const clash = names.find((name, index) => names.indexOf(name) !== index || r.workers.has(name) || r.nodes.has(name));
			if (clash) throw new Error(`Node name "${clash}" is already used in this run.`);
			const known = new Set([...r.workers.keys(), ...r.nodes.keys(), ...names]);
			for (const spec of specs) {
				const after = spec.after ?? [];
				const unknown = after.find((dep) => dep === spec.name || !known.has(dep));
				if (unknown) throw new Error(`${spec.name}: unknown dependency "${unknown}".`);
				if (spec.workdir && !after.includes(spec.workdir)) {
					throw new Error(`${spec.name}: workdir "${spec.workdir}" must also be listed in after.`);
				}
				if (spec.fixes && (spec.kind !== "review" || !after.includes(spec.fixes))) {
					throw new Error(`${spec.name}: fixes needs kind "review" and "${spec.fixes}" in after.`);
				}
			}
			// Earlier nodes cannot depend on new ones, so only this batch can close a cycle.
			const bySpec = new Map(specs.map((spec) => [spec.name, spec]));
			const visiting = new Set<string>();
			const acyclic = new Set<string>();
			const visit = (name: string): void => {
				const spec = bySpec.get(name);
				if (!spec || acyclic.has(name)) return;
				if (visiting.has(name)) throw new Error(`Dependency cycle through "${name}".`);
				visiting.add(name);
				(spec.after ?? []).forEach(visit);
				visiting.delete(name);
				acyclic.add(name);
			};
			names.forEach(visit);

			if (r.pool.length === 0) r.pool = resolvePool(ctx);
			if (r.pool.length === 0) throw new Error("No model in the orchestrator pool has credentials.");

			// A large plan is audited once, before anything starts, so the leader can still change it.
			let auditNote: string | undefined;
			if (!r.planAudited && r.workers.size + r.nodes.size === 0 && specs.length >= config.audit.minNodes) {
				r.planAudited = true;
				try {
					const answer = await askConsultant(
						"Audit this plan before any worker starts. Look for missing or wrong dependencies, nodes that will collide on the same files, acceptance criteria that cannot be checked, missing review or validation nodes, and work beyond the goal. Be concrete, and say plainly if the plan is sound.",
						planContext(r, specs),
						ctx,
						signal,
					);
					return {
						content: [
							{
								type: "text",
								text: [
									`Plan audit by ${answer.ref} (advisory).${answer.note ? ` ${answer.note}` : ""}`,
									answer.text,
									"No node was started. Weigh the audit, revise the graph where it is right, then call orch_spawn again; the plan audit runs once per run.",
								].join("\n\n"),
							},
						],
						details: undefined,
					};
				} catch (error) {
					if (signal?.aborted) throw error;
					auditNote = `Plan audit unavailable (${(error as Error).message}); the graph started unaudited.`;
				}
			}

			for (const spec of specs) r.nodes.set(spec.name, { spec, state: "pending" });
			await schedule();
			const text = [
				`Strategy: ${r.strategy}. ${r.strategyNote}`,
				...(auditNote ? [auditNote] : []),
				`Run directory: ${r.dir}`,
				"",
				...names.map((name) => describeName(r, name, false)),
			].join("\n\n");
			if (names.every((name) => r.nodes.get(name)?.state === "failed")) throw new Error(text);
			return { content: [{ type: "text", text }], details: undefined };
		},
	});

	pi.registerTool({
		name: "orch_wait",
		label: "Orchestrator: Wait",
		description:
			"Block until the named workers (default: all) have finished, or until a worker messages the leader, or the timeout passes. Returns messages and results.",
		defaultActive: false,
		parameters: Type.Object({
			names: Type.Optional(Type.Array(Type.String())),
			timeout_seconds: Type.Optional(Type.Number({ minimum: 1, maximum: 3600, default: 900 })),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			lastCtx = ctx;
			const r = requireRun();
			const targets = () =>
				(params.names?.length ? params.names.map(slugify) : [...r.workers.keys(), ...r.nodes.keys()]).filter(
					(name) => stateOf(r, name) !== undefined,
				);
			const deadline = Date.now() + (params.timeout_seconds ?? 900) * 1000;
			r.waiting++;
			try {
				while (r.inbox.length === 0 && targets().some((name) => isActive(stateOf(r, name)))) {
					const remaining = deadline - Date.now();
					if (remaining <= 0 || signal?.aborted) break;
					let timer: ReturnType<typeof setTimeout> | undefined;
					await new Promise<void>((resolve) => {
						r.waiters.add(resolve);
						timer = setTimeout(resolve, remaining);
						signal?.addEventListener("abort", () => resolve(), { once: true });
					});
					clearTimeout(timer);
				}
			} finally {
				r.waiting--;
			}
			const inbox = r.inbox.splice(0);
			const pending = targets().filter((name) => isActive(stateOf(r, name)));
			const text = [
				inbox.length ? `Messages:\n${inbox.map((line) => `- ${line}`).join("\n")}` : undefined,
				pending.length
					? `Still running or waiting: ${pending.map((name) => `${name} (${stateOf(r, name)})`).join(", ")}`
					: "All targeted workers have finished.",
				...targets()
					.filter((name) => !pending.includes(name))
					.map((name) => describeName(r, name, true)),
			]
				.filter((line): line is string => line !== undefined)
				.join("\n\n");
			return { content: [{ type: "text", text }], details: undefined };
		},
	});

	pi.registerTool({
		name: "orch_send",
		label: "Orchestrator: Send",
		description:
			'Message a worker by name, or "*" for all. A running worker gets it as steering; a finished or blocked worker is reopened with it as new instructions.',
		defaultActive: false,
		parameters: Type.Object({ to: Type.String(), message: Type.String() }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			lastCtx = ctx;
			const r = requireRun();
			if (params.to !== "*" && !r.workers.has(params.to)) {
				throw new Error(`Unknown worker "${params.to}". Known: ${[...r.workers.keys()].join(", ")}`);
			}
			route("leader", params.to, params.message);
			return { content: [{ type: "text", text: `Sent to ${params.to}.` }], details: undefined };
		},
	});

	pi.registerTool({
		name: "orch_status",
		label: "Orchestrator: Status",
		description: "Show the run's strategy, workers, unread messages, and shared board without waiting.",
		defaultActive: false,
		parameters: Type.Object({}),
		async execute(_id, _params, _signal, _onUpdate, ctx) {
			lastCtx = ctx;
			const r = requireRun();
			const text = [
				`Run ${r.id}: ${r.strategy}. ${r.strategyNote}`,
				`Directory: ${r.dir}`,
				r.inbox.length ? `Unread messages (orch_wait returns them):\n${r.inbox.map((line) => `- ${line}`).join("\n")}` : undefined,
				...[...r.workers.values()].map((worker) => describe(worker, false)),
				...[...r.nodes.values()].map(describeNode),
				`Board:\n${clipReport(await readBoard(r.dir))}`,
			]
				.filter((line): line is string => line !== undefined)
				.join("\n\n");
			return { content: [{ type: "text", text }], details: undefined };
		},
	});

	pi.registerTool({
		name: "orch_verdict",
		label: "Orchestrator: Verdict",
		description:
			"Overrule Jev on a finished node. accept marks it accepted, so nodes waiting on it start and nodes skipped because of it are reconsidered; reject marks it rejected, so its dependents are skipped. Use it for needs_leader nodes or a wrong Jev verdict.",
		defaultActive: false,
		parameters: Type.Object({
			name: Type.String(),
			verdict: StringEnum(["accept", "reject"] as const),
			reason: Type.String({ description: "Why, recorded on the node" }),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			lastCtx = ctx;
			const r = requireRun();
			const worker = r.workers.get(slugify(params.name));
			if (!worker) throw new Error(`Unknown or unstarted node "${params.name}". Started: ${[...r.workers.keys()].join(", ")}`);
			if (ACTIVE.has(worker.state)) throw new Error(`${worker.name} is still ${worker.state}; wait for it, or orch_stop it first.`);
			worker.state = params.verdict === "accept" ? "accepted" : "rejected";
			worker.gateNote = `Leader ${params.verdict === "accept" ? "accepted" : "rejected"} it: ${params.reason}`;
			// The scheduler skips them again if another dependency still failed.
			for (const node of r.nodes.values()) {
				if (node.state !== "skipped") continue;
				node.state = "pending";
				node.note = undefined;
			}
			changed();
			await schedule();
			return { content: [{ type: "text", text: describe(worker, false) }], details: undefined };
		},
	});

	pi.registerTool({
		name: "orch_stop",
		label: "Orchestrator: Stop",
		description:
			"Stop worker processes and cancel pending graph nodes by name (default: all). Worktrees and branches are kept for review.",
		defaultActive: false,
		parameters: Type.Object({ names: Type.Optional(Type.Array(Type.String())) }),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			lastCtx = ctx;
			const r = requireRun();
			const workers = params.names?.length
				? params.names.map((name) => r.workers.get(slugify(name))).filter((worker): worker is Worker => !!worker)
				: [...r.workers.values()];
			const nodes = params.names?.length
				? params.names.map((name) => r.nodes.get(slugify(name))).filter((node): node is PendingNode => !!node)
				: [...r.nodes.values()];
			for (const node of nodes) if (node.state === "pending") node.state = "stopped";
			for (const worker of workers) {
				if (!ACTIVE.has(worker.state)) continue;
				if (worker.state === "running") recordOutcome(worker, "stopped", worker.attempts, worker.attemptStart);
				worker.state = "stopped";
			}
			await Promise.all(workers.map(stopWorker));
			changed();
			await schedule();
			const stopped = [...workers.map((worker) => worker.name), ...nodes.map((node) => node.spec.name)];
			return {
				content: [{ type: "text", text: `Stopped: ${stopped.join(", ") || "none"}` }],
				details: undefined,
			};
		},
	});

	pi.registerTool({
		name: "orch_consult",
		label: "Orchestrator: Consult",
		description:
			"Ask a stronger reasoning model (Fable 5.1, or GPT-6 Astra when Claude's limits run hot) one question for a second opinion: a design call, a plan, a doubtful result. It sees nothing of this session but the context you pass, and can read files in your checkout. Takes minutes; the answer is advice, not a decision.",
		promptSnippet: "Get a second opinion from Fable or GPT-6 Astra on a hard decision",
		defaultActive: false,
		parameters: Type.Object({
			question: Type.String({ description: "One focused question" }),
			context: Type.String({
				description: "Everything it needs: goal, constraints, the options you weigh, relevant paths, code, or diffs",
			}),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			lastCtx = ctx;
			const answer = await askConsultant(params.question, params.context, ctx, signal);
			return {
				content: [{ type: "text", text: `Consultant: ${answer.ref}.${answer.note ? ` ${answer.note}` : ""}\n\n${answer.text}` }],
				details: undefined,
			};
		},
	});

	pi.registerTool({
		name: "orch_publish",
		label: "Orchestrator: Publish",
		description:
			"Push an accepted node's branch to origin with the user's GitHub login, optionally opening a draft PR. Sandbox nodes publish their collected `sandbox/<box>/<branch>`; worktree nodes their own branch once it has commits. Never force-pushes and refuses the default branch. Publish only when the goal asks for a push or PR.",
		promptSnippet: "Push an accepted node's branch (and open a draft PR)",
		defaultActive: false,
		parameters: Type.Object({
			name: Type.String({ description: "The accepted node" }),
			as: Type.String({
				description: "Remote branch name, following the repository's conventions (check its recent branches and contributing docs)",
			}),
			pr: Type.Optional(
				Type.Object({
					title: Type.String(),
					body: Type.Optional(Type.String()),
					base: Type.Optional(Type.String({ description: "Default: the repository's default branch" })),
				}),
			),
		}),
		async execute(_id, params, signal, _onUpdate, ctx) {
			lastCtx = ctx;
			const r = requireRun();
			const worker = r.workers.get(slugify(params.name));
			if (!worker) throw new Error(`Unknown or unstarted node "${params.name}". Started: ${[...r.workers.keys()].join(", ")}`);
			if (!DONE_OK.has(worker.state)) {
				throw new Error(`${worker.name} is ${worker.state}; only accepted nodes are published (orch_verdict can accept it).`);
			}
			if (worker.kind === "review" || !worker.branch || !worker.isolated) {
				throw new Error(`${worker.name} has no branch of its own; publish the node whose checkout it worked in.`);
			}
			const exec: Exec = async (command, args, cwd) => {
				const result = await pi.exec(command, args, { cwd, signal });
				if (result.code !== 0) {
					const what = args.filter((arg) => arg !== "-c" && !arg.startsWith("url.")).slice(0, 2).join(" ");
					throw new Error(`${command} ${what} failed: ${result.stderr.trim() || `exit ${result.code}`}`);
				}
				return result.stdout.trim();
			};
			let repo: string;
			let ref: string;
			if (worker.box && worker.cloud) {
				ref = `refs/remotes/sandbox/${worker.box}/${worker.branch}`;
				if (worker.cloud.dest === "local" && !worker.cloud.box) {
					// Collected into this machine's repository when it settled; again if that failed.
					repo = worker.cloud.hostDir;
					const present = await pi.exec("git", ["rev-parse", "--verify", "--quiet", ref], { cwd: repo, signal });
					if (present.code !== 0) worker.collected = await collect(worker.cloud, worker, worker.name);
				} else {
					// Collected on the cloud host or into the leader's sandbox, so it travels here as a bundle.
					repo = await exec("git", ["rev-parse", "--show-toplevel"], ctx.cwd).catch(() => {
						throw new Error(`orch_publish needs a local clone of this repository at ${ctx.cwd}.`);
					});
					await fetchBundle(exec, repo, await bundle(worker.cloud, worker, worker.branch, signal), worker.branch, ref);
				}
			} else {
				if (!worker.repoRoot) throw new Error(`${worker.name} has no local repository to publish from.`);
				repo = worker.repoRoot;
				ref = `refs/heads/${worker.branch}`;
				const ahead = worker.start.head
					? await exec("git", ["rev-list", "--count", `${worker.start.head}..${ref}`], repo)
					: "0";
				if (ahead === "0") {
					throw new Error(`${worker.branch} has no commits: worktree workers do not commit. Commit or integrate the work in ${worker.worktree} first.`);
				}
			}
			const lines = await publishRef(exec, { repo, ref, name: params.as, pr: params.pr });
			return { content: [{ type: "text", text: lines.join("\n") }], details: undefined };
		},
	});

	pi.registerTool({
		name: "mesh_board",
		label: "Mesh Board",
		description: "Read the shared blackboard of decisions and findings for the current orchestration.",
		defaultActive: false,
		parameters: Type.Object({}),
		async execute() {
			return { content: [{ type: "text", text: await readBoard(requireRun().dir) }], details: undefined };
		},
	});

	pi.registerTool({
		name: "mesh_note",
		label: "Mesh Note",
		description: "Append a decision, interface, or finding to the shared blackboard every worker can read.",
		defaultActive: false,
		parameters: BoardNote,
		async execute(_id, params, signal, _onUpdate, ctx) {
			lastCtx = ctx;
			await appendBoard((await ensureRun(ctx, signal)).dir, "leader", params.text);
			return { content: [{ type: "text", text: "Noted on the board." }], details: undefined };
		},
	});
}

export default function orchestrator(pi: ExtensionAPI) {
	if (process.env.ORCH_ROLE === "worker") registerWorker(pi);
	// A consultant is a one-shot child that only answers; it has no run to lead.
	else if (process.env.ORCH_ROLE !== "consultant") registerLeader(pi);
}

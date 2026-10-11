import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, HStack, truncateToWidth, type TUI, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
	accountIdentities,
	type AccountIdentity,
	createLimitsPoller,
	LIMITS_REREAD_MS,
	type LimitsCache,
	type LimitWindow,
} from "./limits.ts";

// OmO's native-badge republishes "(OmO Native by Q Kim)" under this key on every
// session_start and agent_settled, so it is filtered here instead of cleared.
const HIDDEN_STATUSES = new Set(["  omo-native"]);
// OmO's /goal publishes its state and continuation countdown under these keys; while the
// column is on screen they move into its Goal section instead of the footer line.
const GOAL_STATUS = "goal";
const GOAL_WAIT_STATUS = "goal-wait";
const GOAL_OBJECTIVE_LINES = 4;
const SIDEBAR_WIDTH = 42;
const SIDEBAR_MIN_COLUMNS = 120;
const FINISHED_TASKS_SHOWN = 4;
const CHANGED_FILES_SHOWN = 8;
const SIDEBAR_GAP = 2;
// OmO's todo backstop reminds the model this many times before it stops (TODO_OWED_CHAIN_LIMIT).
const TODO_REMINDERS = 2;
const TODO_TASK_LINES = 2;
// Statusline announces whether its column is on screen, so ui-chrome can drop OmO's todo
// widget above the prompt while the Todo section already shows the same list.
const SIDEBAR_EVENT = "statusline:sidebar";
// The only neutral grey background token in the built-in themes; the others are tinted.
const PANEL_BG = "toolPendingBg";
// Early in a window the elapsed fraction is too small for a burn-rate comparison to mean anything.
const PACE_MIN_ELAPSED = 0.05;
// Burn rate over the even-burn rate, banded as in antiburn (via fersilva16/nix-config):
// above 1.0 the window runs out before it resets.
const PACE_BANDS: [below: number, word: string, color: "success" | "muted" | "warning" | "error"][] = [
	[0.8, "comfortable", "success"],
	[1.1, "on pace", "muted"],
	[1.5, "running hot", "warning"],
	[Number.POSITIVE_INFINITY, "at risk", "error"],
];
const SPARK = "▁▂▃▄▅▆▇█";
const BAR_EIGHTHS = ["", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];

type TaskState = { id: string; name: string; kind?: string; model?: string; status: string };
type GitState = {
	branch?: string;
	upstream?: string;
	ahead: number;
	behind: number;
	staged: number;
	modified: number;
	untracked: number;
	conflicts: number;
};
type FileStat = { added?: number; removed?: number };
type TodoTask = { content: string; status: string };
type TodoPhase = { name: string; tasks: TodoTask[] };
type TodoOwed = { chainCount?: number; openTasks?: number; reason?: string };
type OrchestratorState = {
	id: string;
	strategy: string;
	workers: { name: string; state: string; model: string }[];
};
// Only the fullscreen (alt-screen) TUI has a layout root; regular mode writes to scrollback,
// where a fixed column cannot exist.
type ViewportTui = TUI & { layoutRoot?: Component; setLayoutRoot(component: Component | undefined): void };

const ACTIVE_TASK = new Set(["starting", "running", "queued", "pending", "dispatched", "active", "background"]);
const ACTIVE_WORKER = new Set(["running", "gating"]);

function formatTokens(n: number): string {
	if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(1))}M`;
	if (n >= 1_000) return `${Math.round(n / 1_000)}K`;
	return `${n}`;
}

function shortModel(model: string | undefined): string | undefined {
	return model?.split("/").pop();
}

function isViewportTui(tui: TUI | undefined): tui is ViewportTui {
	return typeof (tui as Partial<ViewportTui> | undefined)?.setLayoutRoot === "function";
}

// The column outlives its extension generation: it sits in the host's layout root, which
// /reload keeps. Each column records the chat it wraps under this key, so a later generation
// unwraps a column an earlier one left behind instead of nesting it.
const SIDEBAR_ROOT = Symbol.for("pi-statusline.root");

function wrappedChat(component: Component): Component | undefined {
	return (component as { [SIDEBAR_ROOT]?: Component })[SIDEBAR_ROOT];
}

// After /reload or a session replacement, the retired generation's pi and ctx throw on access;
// the messages mirror OmO's stale-context.ts. Anything else is still a real error.
function isStaleContextError(error: unknown): boolean {
	return (
		error instanceof Error &&
		(error.message === "stale extension generation after reload" ||
			error.message.startsWith("This extension ctx is stale after session replacement or reload."))
	);
}

function ignoreStale(error: unknown): void {
	if (!isStaleContextError(error)) throw error;
}

function formatDuration(ms: number): string {
	const minutes = Math.floor(ms / 60_000);
	if (minutes < 1) return "<1m";
	if (minutes < 60) return `${minutes}m`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function parseGitStatus(output: string): GitState {
	const state: GitState = { ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, conflicts: 0 };
	for (const line of output.split("\n")) {
		if (line.startsWith("# branch.head ")) state.branch = line.slice(14);
		else if (line.startsWith("# branch.upstream ")) state.upstream = line.slice(18);
		else if (line.startsWith("# branch.ab ")) {
			const [ahead, behind] = line.slice(12).split(" ");
			state.ahead = Math.abs(Number(ahead));
			state.behind = Math.abs(Number(behind));
		} else if (line.startsWith("? ")) state.untracked++;
		else if (line.startsWith("u ")) state.conflicts++;
		else if (line.startsWith("1 ") || line.startsWith("2 ")) {
			if (line[2] !== ".") state.staged++;
			if (line[3] !== ".") state.modified++;
		}
	}
	return state;
}

function harnessVersion(): string | undefined {
	const dir = process.env.OMO_PACKAGE_DIR;
	if (!dir) return undefined;
	try {
		return (JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { version?: string }).version;
	} catch {
		return undefined;
	}
}

// Task records reach the session in several envelopes (spawn results, task_output,
// omo-senpi:wake completions nesting senpi-task.completion); each carries task_id + status.
function collectTaskRecords(value: unknown, out: Record<string, unknown>[], depth = 0): void {
	if (depth > 6 || value === null || typeof value !== "object") return;
	if (Array.isArray(value)) {
		for (const item of value) collectTaskRecords(item, out, depth + 1);
		return;
	}
	const record = value as Record<string, unknown>;
	if (typeof record.task_id === "string" && typeof record.status === "string") out.push(record);
	for (const child of Object.values(record)) collectTaskRecords(child, out, depth + 1);
}

function formatCountdown(ms: number): string {
	const minutes = Math.max(0, Math.round(ms / 60_000));
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h${minutes % 60 ? `${minutes % 60}m` : ""}`;
	return `${Math.floor(hours / 24)}d${hours % 24 ? `${hours % 24}h` : ""}`;
}

function meter(percent: number, width: number): string {
	const eighths = Math.round((Math.min(100, Math.max(0, percent)) / 100) * width * 8);
	const full = Math.floor(eighths / 8);
	const partial = BAR_EIGHTHS[eighths % 8];
	return `${"█".repeat(full)}${partial}`.padEnd(width, " ");
}

function sparkline(values: number[], width: number): string {
	const shown = values.slice(-width);
	const peak = Math.max(1, ...shown);
	return shown.map((value) => SPARK[Math.min(SPARK.length - 1, Math.floor((value / peak) * (SPARK.length - 1)))]).join("");
}

function severity(percent: number): "error" | "warning" | "success" {
	return percent >= 90 ? "error" : percent >= 70 ? "warning" : "success";
}

// Where usage would sit at an even burn rate: the elapsed fraction of the window.
function paceOf(window: LimitWindow, now: number): number | undefined {
	if (window.resetsAt === undefined || !window.windowMs) return undefined;
	const elapsed = Math.min(1, Math.max(0, 1 - (window.resetsAt - now) / window.windowMs));
	return elapsed < PACE_MIN_ELAPSED ? undefined : elapsed;
}

// The pace band, and when a hot window would hit 100% if the burn so far continues.
function paceVerdict(window: LimitWindow, now: number): { word: string; color: string; out?: number } | undefined {
	const pace = paceOf(window, now);
	if (pace === undefined || window.resetsAt === undefined || !window.windowMs) return undefined;
	const ratio = window.percent / (pace * 100);
	const [, word, color] = PACE_BANDS.find(([below]) => ratio < below) ?? PACE_BANDS[PACE_BANDS.length - 1];
	const elapsedMs = pace * window.windowMs;
	const out = window.percent > 0 && window.percent < 100 ? now + ((100 - window.percent) / window.percent) * elapsedMs : undefined;
	return { word, color, out: out !== undefined && out < window.resetsAt ? out : undefined };
}

function clockAt(at: number, now: number): string {
	return at - now < 86_400_000
		? new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
		: new Date(at).toLocaleDateString("en-US", { weekday: "short" });
}

const isOpenTask = (status: string) => status === "pending" || status === "in_progress";

// The phase holding the next actionable task, as OmO's own todo widget picks it.
function activePhase(phases: TodoPhase[]): TodoPhase | undefined {
	const all = phases.flatMap((phase) => phase.tasks);
	const next = all.find((task) => task.status === "in_progress") ?? all.find((task) => task.status === "pending");
	return next && phases.find((phase) => phase.tasks.includes(next));
}

function todoMark(theme: Theme, status: string): string {
	if (status === "completed") return theme.fg("success", "✓");
	if (status === "in_progress") return theme.fg("accent", "•");
	if (status === "abandoned") return theme.fg("dim", "✗");
	return theme.fg("dim", "○");
}

function paceColor(percent: number, pace: number | undefined): "error" | "warning" | "success" {
	if (pace === undefined) return severity(percent);
	return percent >= 90 ? "error" : percent > pace * 100 ? "warning" : "success";
}

// The pace tick replaces one cell, so it stays visible over the filled part of the bar too.
function paceBar(theme: Theme, percent: number, width: number, pace: number | undefined, color: ReturnType<typeof paceColor>): string {
	const cells = [...meter(percent, width)];
	const filled = cells.join("").trimEnd().length;
	const mark = pace === undefined ? -1 : Math.min(width - 1, Math.floor(pace * width));
	const styleAt = (index: number) => (index === mark ? "mark" : index < filled ? "fill" : "rest");
	let out = "";
	for (let start = 0; start < width; ) {
		const style = styleAt(start);
		let end = start + 1;
		while (end < width && styleAt(end) === style) end++;
		const run = cells.slice(start, end).join("");
		if (style === "mark") out += theme.fg("accent", "┃");
		else if (style === "fill") out += theme.fg(color, run);
		else out += theme.fg("dim", "░".repeat(end - start));
		start = end;
	}
	return out;
}

function statusIcon(theme: Theme, status: string): string {
	if (ACTIVE_TASK.has(status) || ACTIVE_WORKER.has(status)) return theme.fg("warning", "◐");
	if (["completed", "accepted", "done_ungated"].includes(status)) return theme.fg("success", "✓");
	if (["failed", "error", "rejected", "lost"].includes(status)) return theme.fg("error", "✗");
	if (status === "needs_leader") return theme.fg("warning", "?");
	return theme.fg("dim", "·");
}

export default function statusline(pi: ExtensionAPI) {
	let ctx: ExtensionContext | undefined;
	// Cleared on session_shutdown: the old footer keeps rendering until the next generation
	// replaces it, and must not re-attach a column that would render through a retired ctx.
	let active = false;
	let tui: TUI | undefined;
	let agentRunning = false;
	let sidebarEnabled = true;
	let orchestrator: OrchestratorState | undefined;
	let layout: { tui: ViewportTui; chat: Component; root: HStack } | undefined;
	let footerBranch: (() => string | null) | undefined;
	let footerStatuses: (() => ReadonlyMap<string, string>) | undefined;
	let goalObjective: string | undefined;
	let goalStatusSeen: string | undefined;
	const tasks = new Map<string, TaskState>();
	const inflight = new Map<string, TaskState[]>();
	let usage = { leafId: undefined as string | null | undefined, cost: 0, cacheHit: undefined as number | undefined };
	let session = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, startedAt: undefined as number | undefined };
	let turnTokens: number[] = [];
	let limits: LimitsCache | undefined;
	let identities: AccountIdentity[] = [];
	let limitsTimer: ReturnType<typeof setInterval> | undefined;
	let todos: TodoPhase[] = [];
	let todoOwed: TodoOwed | undefined;
	let announcedSidebar: boolean | undefined;
	const changedFiles = new Map<string, FileStat>();
	let git: GitState | undefined;
	let gitRefresh: { running: boolean; again: boolean } = { running: false, again: false };

	const harness =
		process.env.ORCH_ROLE === "worker"
			? `worker ${process.env.ORCH_AGENT ?? ""}`.trim()
			: process.env.OMO_NATIVE === "1"
				? "OmO"
				: "Pi";
	const version = harnessVersion();

	const render = () => tui?.requestRender();
	// Each limits update re-reads the credential stores, so a login switch shows up with it.
	const limitsPoller = createLimitsPoller((cache) => {
		limits = cache;
		render();
		void accountIdentities().then((next) => {
			identities = next;
			render();
		});
	});
	// Only processes with a mounted TUI poll; headless and RPC workers never render the result.
	const startLimits = () => {
		if (limitsTimer) return;
		void limitsPoller.tick();
		limitsTimer = setInterval(() => void limitsPoller.tick(), LIMITS_REREAD_MS);
		limitsTimer.unref?.();
	};
	const stopLimits = () => {
		if (limitsTimer) clearInterval(limitsTimer);
		limitsTimer = undefined;
		limitsPoller.stop();
	};
	const sidebarShown = () =>
		sidebarEnabled && layout !== undefined && layout.tui.terminal.columns >= SIDEBAR_MIN_COLUMNS;

	const mergeRecord = (record: Record<string, unknown>) => {
		const id = record.task_id as string;
		const previous = tasks.get(id);
		const resolved = record.resolved_model as { model_id?: string } | undefined;
		tasks.delete(id);
		tasks.set(id, {
			id,
			name: (record.name as string) ?? (record.task_summary as string) ?? previous?.name ?? id,
			kind: (record.category as string) ?? (record.subagent_type as string) ?? previous?.kind,
			model: resolved?.model_id ?? shortModel(record.model as string) ?? previous?.model,
			status: record.status as string,
		});
	};

	const syncFromSession = () => {
		if (!ctx) return;
		const leafId = ctx.sessionManager.getLeafId();
		if (leafId === usage.leafId) return;
		tasks.clear();
		let cost = 0;
		let cacheHit: number | undefined;
		const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0, startedAt: undefined as number | undefined };
		const perTurn: number[] = [];
		const editedPaths = new Set<string>();
		const pendingEdits = new Map<string, string>();
		let phases: TodoPhase[] = [];
		for (const entry of ctx.sessionManager.getBranch()) {
			totals.startedAt ??= Date.parse(entry.timestamp);
			// OmO persists the list as senpi.todo-state entries and todo tool results; the latest wins.
			const todoPayload =
				entry.type === "custom" && entry.customType === "senpi.todo-state"
					? entry.data
					: entry.type === "message" && entry.message.role === "toolResult" && /^todo(write)?$/.test(entry.message.toolName)
						? entry.message.details
						: undefined;
			const nextPhases = (todoPayload as { phases?: unknown } | undefined)?.phases;
			if (Array.isArray(nextPhases)) phases = nextPhases as TodoPhase[];
			if (entry.type === "message") {
				const message = entry.message;
				if (message.role === "assistant") {
					cost += message.usage.cost.total;
					totals.input += message.usage.input;
					totals.output += message.usage.output;
					totals.cacheRead += message.usage.cacheRead;
					totals.cacheWrite += message.usage.cacheWrite;
					totals.turns++;
					perTurn.push(message.usage.input + message.usage.output + message.usage.cacheRead + message.usage.cacheWrite);
					for (const part of message.content) {
						if (part.type !== "toolCall" || !/^(edit|write)$/i.test(part.name)) continue;
						const path = (part.arguments as { path?: unknown }).path;
						if (typeof path === "string") pendingEdits.set(part.id, path);
					}
					const prompt = message.usage.input + message.usage.cacheRead + message.usage.cacheWrite;
					if (prompt > 0) cacheHit = (message.usage.cacheRead / prompt) * 100;
				} else if (message.role === "toolResult" && pendingEdits.has(message.toolCallId)) {
					if (!message.isError) editedPaths.add(resolve(ctx.cwd, pendingEdits.get(message.toolCallId)!));
				} else if (message.role === "toolResult" && message.toolName.toLowerCase().startsWith("task")) {
					const records: Record<string, unknown>[] = [];
					collectTaskRecords(message.details, records);
					records.forEach(mergeRecord);
				}
			} else if (entry.type === "custom_message") {
				const records: Record<string, unknown>[] = [];
				collectTaskRecords(entry.details, records);
				records.forEach(mergeRecord);
			}
		}
		usage = { leafId, cost, cacheHit };
		todos = phases;
		session = totals;
		turnTokens = perTurn;
		const added = [...editedPaths].filter((path) => !changedFiles.has(path));
		for (const path of [...changedFiles.keys()]) if (!editedPaths.has(path)) changedFiles.delete(path);
		for (const path of added) changedFiles.set(path, {});
		if (added.length > 0) void refreshGit();
		render();
	};

	const git$ = async (args: string[]) => {
		const result = await pi.exec("git", args, { cwd: ctx!.cwd, timeout: 5000 });
		return result.code === 0 ? result.stdout : undefined;
	};

	// git runs off the render path; overlapping triggers coalesce into one follow-up run.
	const refreshGit = async (): Promise<void> => {
		if (!ctx || !active) return;
		if (gitRefresh.running) {
			gitRefresh.again = true;
			return;
		}
		gitRefresh = { running: true, again: false };
		try {
			const status = await git$(["status", "--porcelain=v2", "--branch"]);
			git = status === undefined ? undefined : parseGitStatus(status);
			const root = git ? (await git$(["rev-parse", "--show-toplevel"]))?.trim() : undefined;
			const paths = [...changedFiles.keys()];
			if (root && paths.length > 0) {
				const numstat = (await git$(["diff", "HEAD", "--numstat", "--", ...paths])) ?? "";
				const stats = new Map<string, FileStat>();
				for (const line of numstat.split("\n")) {
					const [added, removed, file] = line.split("\t");
					if (file) stats.set(join(root, file), { added: Number(added), removed: Number(removed) });
				}
				for (const path of paths) {
					let stat = stats.get(path);
					if (!stat) {
						try {
							const text = readFileSync(path, "utf8");
							const untracked = (await git$(["ls-files", "--error-unmatch", "--", path])) === undefined;
							stat = untracked ? { added: text.split("\n").length - (text.endsWith("\n") ? 1 : 0), removed: 0 } : { added: 0, removed: 0 };
						} catch {
							stat = {};
						}
					}
					if (changedFiles.has(path)) changedFiles.set(path, stat);
				}
			}
		} catch (error) {
			ignoreStale(error);
		} finally {
			const again = gitRefresh.again;
			gitRefresh = { running: false, again: false };
			render();
			if (again) void refreshGit();
		}
	};

	const usingSubscription = (): boolean => {
		const model = ctx?.model;
		const provider = model ? ctx?.modelRegistry.getProvider(model.provider) : undefined;
		return (provider as { auth?: { oauth?: { isSubscription?: boolean } } } | undefined)?.auth?.oauth?.isSubscription === true;
	};

	const cwdLabel = (): string => {
		const home = process.env.HOME ?? "";
		const cwd = ctx?.cwd ?? "";
		return home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd;
	};

	const modelLabel = (theme: Theme): string => {
		const model = ctx?.model;
		const thinking = model?.reasoning ? theme.fg("dim", `:${pi.getThinkingLevel()}`) : "";
		return theme.fg("accent", model?.id ?? "no-model") + thinking;
	};

	const leftRight = (left: string, right: string, width: number, theme: Theme): string => {
		const room = width - visibleWidth(right) - 2;
		if (room < 10) return truncateToWidth(right, width);
		const fitted = truncateToWidth(left, room, theme.fg("dim", "…"));
		return fitted + " ".repeat(Math.max(2, width - visibleWidth(fitted) - visibleWidth(right))) + right;
	};

	// OmO keeps the objective beside the session (its goalStoreRef); unsaved sessions store it
	// elsewhere, and the section then shows the status alone.
	const loadGoalObjective = async () => {
		const manager = ctx?.sessionManager;
		if (!manager?.getSessionFile()) {
			goalObjective = undefined;
			return;
		}
		const file = join(manager.getSessionDir(), "extensions", "goal", `${encodeURIComponent(manager.getSessionId())}.json`);
		try {
			const stored = JSON.parse(await readFile(file, "utf8")) as { goal?: { objective?: unknown } };
			goalObjective = typeof stored.goal?.objective === "string" ? stored.goal.objective : undefined;
		} catch {
			// A missing or mid-write store only costs the objective line until the next status change.
			goalObjective = undefined;
		}
		render();
	};

	const statusText = (statuses: ReadonlyMap<string, string>, sidebar: boolean): string =>
		[...statuses.entries()]
			.filter(([key]) => !HIDDEN_STATUSES.has(key) && !(sidebar && (key === GOAL_STATUS || key === GOAL_WAIT_STATUS)))
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([, text]) => text.replace(/[\r\n\t]+/g, " "))
			.join(" ");

	const fullFooterLine = (theme: Theme, width: number): string => {
		if (!ctx) return "";
		const left = [theme.fg("accent", cwdLabel())];
		const branch = footerBranch?.();
		if (branch) left.push(theme.fg("warning", branch));
		const title = pi.getSessionName();
		if (title) left.push(theme.fg("muted", title));
		if (usage.cacheHit !== undefined && usage.cacheHit >= 10) left.push(theme.fg("dim", `CH${usage.cacheHit.toFixed(1)}%`));
		const subscription = usingSubscription();
		if (usage.cost > 0 || subscription) {
			left.push(theme.fg("success", `$${usage.cost.toFixed(3)}${subscription ? " (sub)" : ""}`));
		}
		const context = ctx.getContextUsage();
		if (context) {
			const percent = context.percent ?? undefined;
			const text = `${formatTokens(context.tokens ?? 0)}/${formatTokens(context.contextWindow)}${percent === undefined ? "" : ` (${percent.toFixed(1)}%)`}`;
			left.push(theme.fg((percent ?? 0) > 90 ? "error" : (percent ?? 0) > 70 ? "warning" : "muted", text));
		}
		// Without the sidebar, each provider shows only its tightest window.
		const now = Date.now();
		for (const provider of limits?.providers ?? []) {
			const tightest = [...provider.windows].sort((a, b) => b.percent - a.percent)[0];
			if (!tightest) continue;
			const color = provider.error ? "dim" : paceColor(tightest.percent, paceOf(tightest, now));
			left.push(theme.fg(color, `${provider.title} ${tightest.label} ${Math.round(tightest.percent)}%`));
		}
		if (todoOwed?.reason === "capped") left.push(theme.fg("warning", `todos stalled (${todoOwed.openTasks ?? 0})`));
		return leftRight(left.join(theme.fg("borderMuted", " • ")), modelLabel(theme), width, theme);
	};

	class Sidebar implements Component {
		constructor(
			private readonly theme: Theme,
			private readonly rows: () => number,
		) {}

		private last: string[] = [];

		invalidate(): void {}

		render(width: number): string[] {
			try {
				this.last = this.draw(width);
			} catch (error) {
				ignoreStale(error);
			}
			return this.last;
		}

		private agentLines(inner: number): string[] {
			const th = this.theme;
			const lines = [th.bold("Agents")];
			lines.push(`${agentRunning ? th.fg("warning", "●") : th.fg("success", "●")} ${harness} ${th.fg("dim", agentRunning ? "working" : "idle")}`);
			const all = [...tasks.values(), ...[...inflight.values()].flat()];
			const active = all.filter((task) => ACTIVE_TASK.has(task.status));
			const finished = all.filter((task) => !ACTIVE_TASK.has(task.status)).slice(-FINISHED_TASKS_SHOWN);
			const shown = [...active, ...finished];
			shown.forEach((task, index) => {
				const last = index === shown.length - 1;
				lines.push(truncateToWidth(`${th.fg("dim", last ? "└" : "├")} ${statusIcon(th, task.status)} ${task.name}`, inner, "…"));
				const meta = [task.kind, task.model].filter(Boolean).join(" · ");
				if (meta) lines.push(truncateToWidth(`${th.fg("dim", last ? " " : "│")}   ${th.fg("dim", meta)}`, inner, "…"));
			});
			if (all.length > shown.length) lines.push(th.fg("dim", `  +${all.length - shown.length} earlier`));

			if (orchestrator && orchestrator.workers.length > 0) {
				lines.push("", `${th.bold("Orchestrator")} ${th.fg("dim", `${orchestrator.strategy} · ${orchestrator.id}`)}`);
				const workers = orchestrator.workers;
				workers.forEach((worker, index) => {
					const last = index === workers.length - 1;
					lines.push(truncateToWidth(`${th.fg("dim", last ? "└" : "├")} ${statusIcon(th, worker.state)} ${worker.name} ${th.fg("dim", worker.state)}`, inner, "…"));
					lines.push(truncateToWidth(`${th.fg("dim", last ? " " : "│")}   ${th.fg("dim", shortModel(worker.model) ?? "")}`, inner, "…"));
				});
			}
			return lines;
		}

		private goalLines(inner: number): string[] {
			const statuses = footerStatuses?.();
			const state = statuses?.get(GOAL_STATUS);
			if (!state) return [];
			const th = this.theme;
			const flat = (text: string) => text.replace(/[\r\n\t]+/g, " ");
			const lines = [th.bold("Goal"), ...wrapTextWithAnsi(th.fg("muted", flat(state)), inner).slice(0, 2)];
			if (goalObjective) {
				const wrapped = wrapTextWithAnsi(flat(goalObjective), inner);
				const shown = wrapped.slice(0, GOAL_OBJECTIVE_LINES);
				if (wrapped.length > shown.length) shown[shown.length - 1] = truncateToWidth(`${shown[shown.length - 1]} …`, inner, "…");
				lines.push(...shown);
			}
			const wait = statuses?.get(GOAL_WAIT_STATUS);
			if (wait) lines.push(...wrapTextWithAnsi(th.fg("dim", flat(wait)), inner).slice(0, 2));
			return lines;
		}

		// Every phase with its progress; only the active phase lists its tasks.
		private todoLines(inner: number): string[] {
			const active = activePhase(todos);
			if (!active) return [];
			const th = this.theme;
			const marker = !todoOwed
				? ""
				: todoOwed.reason === "capped"
					? th.fg("warning", ` stopped · ${todoOwed.openTasks ?? 0} open`)
					: th.fg("dim", ` reminded ${todoOwed.chainCount ?? 1}/${TODO_REMINDERS}`);
			const lines = [`${th.bold("Todo")}${marker}`];
			for (const phase of todos) {
				const done = phase.tasks.filter((task) => !isOpenTask(task.status)).length;
				const progress = `${done}/${phase.tasks.length}`;
				if (phase !== active) {
					lines.push(truncateToWidth(th.fg("dim", `${phase.name} ${progress}`), inner, "…"));
					continue;
				}
				lines.push(truncateToWidth(`${phase.name} ${th.fg("dim", progress)}`, inner, "…"));
				for (const task of phase.tasks) {
					const text = task.status === "in_progress" ? task.content : th.fg("muted", task.content);
					const wrapped = wrapTextWithAnsi(text, Math.max(1, inner - 2));
					const shown = wrapped.slice(0, TODO_TASK_LINES);
					if (wrapped.length > shown.length) shown[shown.length - 1] = truncateToWidth(`${shown[shown.length - 1]} …`, inner - 2, "…");
					shown.forEach((line, index) => lines.push(`${index === 0 ? todoMark(th, task.status) : " "} ${line}`));
				}
			}
			return lines;
		}

		private contextLines(): string[] {
			const th = this.theme;
			const lines = [th.bold("Context")];
			const context = ctx?.getContextUsage();
			if (context) {
				lines.push(th.fg("muted", `${(context.tokens ?? 0).toLocaleString("en-US")} tokens`));
				if (context.percent !== null && context.percent !== undefined) {
					const color = context.percent > 90 ? "error" : context.percent > 70 ? "warning" : "muted";
					lines.push(th.fg(color, `${Math.round(context.percent)}% used of ${formatTokens(context.contextWindow)}`));
				}
			}
			lines.push(th.fg("muted", `$${usage.cost.toFixed(2)} spent${usingSubscription() ? " (sub)" : ""}`));
			if (usage.cacheHit !== undefined) lines.push(th.fg("muted", `${usage.cacheHit.toFixed(1)}% cache hit`));
			return lines;
		}

		private sessionLines(inner: number): string[] {
			const th = this.theme;
			const duration = session.startedAt === undefined ? "" : ` · ${formatDuration(Date.now() - session.startedAt)}`;
			const lines = [
				th.bold("Session"),
				th.fg("muted", `${formatTokens(session.input)} in · ${formatTokens(session.output)} out`),
				th.fg("muted", `${formatTokens(session.cacheRead)} cached · ${formatTokens(session.cacheWrite)} written`),
				th.fg("muted", `${session.turns} turns${duration}`),
			];
			if (turnTokens.length > 1) {
				const peak = `peak ${formatTokens(Math.max(...turnTokens))}`;
				const spark = sparkline(turnTokens, Math.max(4, inner - peak.length - 1));
				lines.push(`${th.fg("accent", spark)} ${th.fg("dim", peak)}`);
			}
			return lines;
		}

		private limitLines(inner: number): string[] {
			const providers = limits?.providers ?? [];
			if (providers.length === 0) return [];
			const th = this.theme;
			const now = Date.now();
			const lines = [th.bold("Limits")];
			const labels = providers.flatMap((provider) => provider.windows.map((window) => window.label));
			const labelWidth = Math.max(...labels.map((label) => label.length), 5);
			const barWidth = Math.max(6, inner - labelWidth - 4 - 6 - 3);
			const row = (label: string, percent: number, pace: number | undefined, tail: string) => {
				const bar = paceBar(th, percent, barWidth, pace, paceColor(percent, pace));
				return truncateToWidth(
					`${th.fg("muted", label.padEnd(labelWidth))} ${bar} ${`${Math.round(percent)}%`.padStart(4)} ${th.fg("dim", tail)}`,
					inner,
					"…",
				);
			};
			for (const provider of providers) {
				const meta = [
					...(provider.plan ? [provider.plan] : []),
					...(provider.accounts > 1
						? [provider.ok < provider.accounts ? `${provider.ok}/${provider.accounts} accounts` : `${provider.accounts} accounts`]
						: []),
					...(provider.error ? [`${provider.windows.length ? "stale" : "unavailable"} (${provider.error})`] : []),
				];
				lines.push(truncateToWidth(`${th.fg("accent", provider.title)}${meta.length ? th.fg("dim", ` ${meta.join(" · ")}`) : ""}`, inner, "…"));
				const emails = new Set(identities.flatMap((identity) => (identity.provider === provider.id ? [identity.email] : [])));
				for (const email of emails) lines.push(truncateToWidth(th.fg("muted", email), inner, "…"));
				for (const window of provider.windows) {
					const tail = window.resetsAt ? formatCountdown(window.resetsAt - now) : "";
					lines.push(row(window.label, window.percent, paceOf(window, now), tail));
					// Comfortable and on-pace windows need no words; the tick already says so.
					const verdict = paceVerdict(window, now);
					if (verdict && (verdict.color === "warning" || verdict.color === "error")) {
						const out = verdict.out === undefined ? "" : ` · out ${clockAt(verdict.out, now)}`;
						lines.push(truncateToWidth(`${" ".repeat(labelWidth + 1)}${th.fg(verdict.color, `${verdict.word}${out}`)}`, inner, "…"));
					}
				}
				if (provider.spend) {
					const money = new Intl.NumberFormat("en-US", { style: "currency", currency: provider.spend.currency, maximumFractionDigits: 0 });
					lines.push(row("extra", provider.spend.percent, undefined, ""));
					lines.push(th.fg("dim", `${" ".repeat(labelWidth + 1)}${money.format(provider.spend.used)} of ${money.format(provider.spend.limit)} this month`));
				}
			}
			return lines;
		}

		private fileLines(inner: number): string[] {
			if (changedFiles.size === 0) return [];
			const th = this.theme;
			const cwd = ctx?.cwd ?? "";
			const lines = [`${th.bold("Modified Files")} ${th.fg("dim", `${changedFiles.size}`)}`];
			const entries = [...changedFiles.entries()].reverse();
			for (const [path, stat] of entries.slice(0, CHANGED_FILES_SHOWN)) {
				const stats =
					stat.added === undefined
						? ""
						: `${th.fg("success", `+${stat.added}`)} ${th.fg("error", `-${stat.removed ?? 0}`)}`;
				const label = path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;
				const room = Math.max(4, inner - visibleWidth(stats) - 1);
				const name = label.length > room ? `…${label.slice(label.length - room + 1)}` : label;
				lines.push(name + " ".repeat(Math.max(1, inner - visibleWidth(name) - visibleWidth(stats))) + stats);
			}
			if (entries.length > CHANGED_FILES_SHOWN) lines.push(th.fg("dim", `+${entries.length - CHANGED_FILES_SHOWN} more`));
			return lines;
		}

		private gitLines(inner: number): string[] {
			const th = this.theme;
			const lines = [truncateToWidth(cwdLabel(), inner, "…")];
			const branch = git?.branch ?? footerBranch?.();
			if (!branch) return lines;
			const sync = [
				...(git?.ahead ? [th.fg("success", `↑${git.ahead}`)] : []),
				...(git?.behind ? [th.fg("warning", `↓${git.behind}`)] : []),
			];
			const upstream = git?.upstream ? th.fg("dim", ` → ${git.upstream}`) : "";
			lines.push(truncateToWidth(`${th.fg("warning", branch)}${upstream}${sync.length ? ` ${sync.join(" ")}` : ""}`, inner, "…"));
			if (git) {
				const counts = [
					...(git.staged ? [th.fg("success", `${git.staged} staged`)] : []),
					...(git.modified ? [th.fg("warning", `${git.modified} modified`)] : []),
					...(git.untracked ? [th.fg("muted", `${git.untracked} untracked`)] : []),
					...(git.conflicts ? [th.fg("error", `${git.conflicts} conflicts`)] : []),
				];
				lines.push(counts.length ? counts.join(th.fg("dim", " · ")) : th.fg("dim", "clean"));
			}
			return lines;
		}

		private draw(width: number): string[] {
			const th = this.theme;
			const padLeft = 2;
			const inner = Math.max(1, width - padLeft - 1);
			const title = pi.getSessionName() ?? "Untitled session";
			const top = [
				"",
				...wrapTextWithAnsi(th.bold(title), inner).slice(0, 4),
				"",
			];
			const goal = this.goalLines(inner);
			if (goal.length > 0) top.push(...goal, "");
			top.push(...this.contextLines(), "", ...this.sessionLines(inner), "");
			const limited = this.limitLines(inner);
			if (limited.length > 0) top.push(...limited, "");
			const todoList = this.todoLines(inner);
			if (todoList.length > 0) top.push(...todoList, "");
			top.push(...this.agentLines(inner));
			const files = this.fileLines(inner);
			if (files.length > 0) top.push("", ...files);
			const bottom = [
				...this.gitLines(inner),
				"",
				`${th.fg(agentRunning ? "warning" : "success", "•")} ${th.bold(harness)}${version ? ` ${th.fg("dim", version)}` : ""}`,
				"",
			];
			const height = Math.max(1, this.rows());
			const room = Math.max(0, height - bottom.length);
			const body = [...top.slice(0, room), ...Array.from({ length: Math.max(0, room - top.length) }, () => ""), ...bottom].slice(0, height);

			// Inner styles end with targeted resets (39m, 22m); a full reset would drop the panel
			// background, so it is reapplied after any that appear.
			const [bgOpen] = th.bg(PANEL_BG, "\u0000").split("\u0000");
			return body.map((line) => {
				const text = " ".repeat(padLeft) + truncateToWidth(line, inner, "…");
				const padded = text + " ".repeat(Math.max(0, width - visibleWidth(text)));
				return th.bg(PANEL_BG, padded.replaceAll("\x1b[0m", `\x1b[0m${bgOpen}`));
			});
		}
	}

	const attachSidebar = (target: ViewportTui, theme: Theme) => {
		if (!active || !target.layoutRoot || (layout && target.layoutRoot === layout.root)) return;
		let chat = target.layoutRoot;
		for (let inner = wrappedChat(chat); inner; inner = wrappedChat(chat)) chat = inner;
		const root = new HStack([
			{ component: chat, basis: 0, grow: 1, shrink: 1, minSize: 40 },
			{
				component: new Sidebar(theme, () => target.terminal.rows),
				basis: SIDEBAR_WIDTH,
				grow: 0,
				shrink: 0,
				minSize: SIDEBAR_WIDTH,
				visible: (viewport: { width: number }) => sidebarEnabled && viewport.width >= SIDEBAR_MIN_COLUMNS,
			},
		], { gap: SIDEBAR_GAP });
		Object.defineProperty(root, SIDEBAR_ROOT, { value: chat });
		layout = { tui: target, chat, root };
		target.setLayoutRoot(root);
	};

	const detachSidebar = () => {
		if (layout && layout.tui.layoutRoot === layout.root) layout.tui.setLayoutRoot(layout.chat);
		layout = undefined;
	};

	const install = (next: ExtensionContext) => {
		ctx = next;
		usage.leafId = undefined;
		if (!next.hasUI) return;
		next.ui.setFooter((footerTui, theme, footerData) => {
			tui = footerTui;
			footerBranch = () => footerData.getGitBranch();
			footerStatuses = () => footerData.getExtensionStatuses();
			const unsubscribe = footerData.onBranchChange(() => footerTui.requestRender());
			syncFromSession();
			startLimits();
			return {
				invalidate() {},
				dispose() {
					unsubscribe();
					announcedSidebar = undefined;
					stopLimits();
					detachSidebar();
					tui = undefined;
					footerStatuses = undefined;
					// /reload and session replacement dispose the footer after session_shutdown, when
					// this generation's pi.events throws; the next generation announces its own state.
					if (active) pi.events.emit(SIDEBAR_EVENT, { shown: false });
				},
				render(width: number): string[] {
					try {
						syncFromSession();
						// The host mounts its fullscreen layout after the footer exists and remounts it
						// when the TUI mode changes, so the column is (re)attached from here, off-frame.
						if (isViewportTui(footerTui) && footerTui.layoutRoot && footerTui.layoutRoot !== layout?.root) {
							queueMicrotask(() => attachSidebar(footerTui, theme));
						}
						const shown = sidebarShown();
						if (shown !== announcedSidebar) {
							announcedSidebar = shown;
							pi.events.emit(SIDEBAR_EVENT, { shown });
							queueMicrotask(render);
						}
						const all = footerData.getExtensionStatuses();
						// The elapsed label ticks, so the objective is re-read at most once per tick.
						const goalStatus = all.get(GOAL_STATUS);
						if (goalStatus !== goalStatusSeen) {
							goalStatusSeen = goalStatus;
							if (goalStatus) void loadGoalObjective().catch(ignoreStale);
							else goalObjective = undefined;
						}
						const statuses = statusText(all, shown);
						if (shown) return [leftRight(theme.fg("dim", statuses), modelLabel(theme), width, theme)];
						const lines = [fullFooterLine(theme, width)];
						if (statuses) lines.push(truncateToWidth(statuses, width, theme.fg("dim", "...")));
						return lines;
					} catch (error) {
						ignoreStale(error);
						return [];
					}
				},
			};
		});
	};

	const toggleSidebar = (target: ExtensionContext) => {
		sidebarEnabled = !sidebarEnabled;
		if (sidebarEnabled && target.hasUI) {
			if (!layout) target.ui.notify('The sidebar needs fullscreen mode ("tuiMode": "fullscreen")', "info");
			else if (layout.tui.terminal.columns < SIDEBAR_MIN_COLUMNS) {
				target.ui.notify(`The sidebar needs at least ${SIDEBAR_MIN_COLUMNS} columns`, "info");
			}
		}
		render();
	};

	pi.on("session_start", async (_event, next) => {
		active = true;
		todoOwed = undefined;
		goalStatusSeen = undefined;
		install(next);
		void refreshGit();
	});
	pi.on("session_shutdown", async () => {
		active = false;
		stopLimits();
		detachSidebar();
	});
	pi.on("session_info_changed", async () => render());
	pi.on("agent_start", async () => {
		agentRunning = true;
		render();
	});
	// OmO resets its reminder chain on user input, and so does the marker. A delivered reminder
	// starts a new agent run itself, so agent_start would clear it too early.
	pi.on("input", async () => {
		todoOwed = undefined;
		render();
	});
	pi.on("agent_settled", async (_event, next) => {
		ctx = next;
		agentRunning = false;
		void refreshGit();
		if (limitsTimer) void limitsPoller.tick();
	});
	pi.on("message_end", async () => render());

	// Foreground task calls have no record until they return, so show them from their arguments.
	pi.on("tool_execution_start", async (event) => {
		if (event.toolName.toLowerCase() !== "task") return;
		const args = event.args as Record<string, unknown>;
		const specs = Array.isArray(args.tasks) ? (args.tasks as Record<string, unknown>[]) : [args];
		inflight.set(
			event.toolCallId,
			specs.map((spec, index) => ({
				id: `${event.toolCallId}:${index}`,
				name: (spec.name ?? spec.task_summary ?? spec.description ?? "task") as string,
				kind: (spec.category ?? spec.subagent_type ?? args.category ?? args.subagent_type) as string | undefined,
				status: "starting",
			})),
		);
		render();
	});
	pi.on("tool_execution_end", async (event) => {
		if (/^(edit|write|bash|eval)$/i.test(event.toolName)) {
			usage.leafId = undefined;
			void refreshGit();
		}
		if (!inflight.delete(event.toolCallId)) return;
		usage.leafId = undefined;
		render();
	});

	pi.events.on("orchestrator:state", (state) => {
		orchestrator = state as OrchestratorState;
		render();
	});
	// OmO's todo backstop emits "delivered" for each reminder and "capped" when it stops
	// reminding: the model ended its turn with todos open after the final reminder, and nothing
	// will resume it without the user.
	pi.events.on("todo_owed_reminder", (payload) => {
		const event = payload as TodoOwed & { sessionId?: string };
		if (event.sessionId && ctx && event.sessionId !== ctx.sessionManager.getSessionId()) return;
		todoOwed = event;
		render();
	});

	pi.registerCommand("sidebar", {
		description: "Toggle the session sidebar",
		handler: async (_args, next) => toggleSidebar(next),
	});
	pi.registerShortcut("ctrl+shift+b", {
		description: "Toggle the session sidebar",
		handler: async (next) => toggleSidebar(next),
	});
}

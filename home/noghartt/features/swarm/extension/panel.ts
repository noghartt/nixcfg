import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type DaemonInfo, formatPost, type Member, type Post, runDir, SwarmClient, type SwarmState, swarmsRoot } from "../src/protocol.ts";
import { sleep } from "./common.ts";

type Action =
	| { type: "attach"; id: string; member: string }
	| { type: "message"; id: string; member: string }
	| { type: "stop"; id: string; member: string }
	| { type: "decide"; id: string; permission: string }
	| { type: "lead"; id: string };

interface Theme {
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
}

interface Snapshot {
	state: SwarmState & { attach?: Record<string, string[]> };
	live: boolean;
	board: Post[];
}

const STATE_COLOR: Record<string, string> = {
	queued: "dim",
	starting: "warning",
	running: "accent",
	idle: "warning",
	done: "success",
	failed: "error",
	stopped: "muted",
};

function readJson<T>(path: string): T | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

function clientFor(id: string): SwarmClient | undefined {
	const info = readJson<Partial<DaemonInfo>>(join(runDir(id), "daemon.json"));
	if (!info?.pid || !info.port || !info.token) return undefined;
	try {
		process.kill(info.pid, 0);
	} catch {
		return undefined;
	}
	return SwarmClient.fromInfo(info as DaemonInfo);
}

function listSwarms(): SwarmState[] {
	let ids: string[] = [];
	try {
		ids = readdirSync(swarmsRoot());
	} catch {
		return [];
	}
	return ids
		.map((id) => readJson<SwarmState>(join(runDir(id), "state.json")))
		.filter((state): state is SwarmState => !!state)
		.sort((a, b) => b.spec.createdAt.localeCompare(a.spec.createdAt));
}

async function snapshot(id: string): Promise<Snapshot | undefined> {
	const client = clientFor(id);
	if (client) {
		try {
			const [state, page] = await Promise.all([client.get<Snapshot["state"]>("/state", AbortSignal.timeout(3_000)), client.get<{ posts: Post[] }>("/board?limit=60", AbortSignal.timeout(3_000))]);
			return { state, live: true, board: page.posts };
		} catch {}
	}
	const state = readJson<SwarmState>(join(runDir(id), "state.json"));
	return state ? { state, live: false, board: [] } : undefined;
}

class SwarmPanel {
	private view: "swarms" | "members" | "board" = "swarms";
	private swarms: SwarmState[] = [];
	private cursor = 0;
	private memberCursor = 0;
	private selected?: Snapshot;
	private showAll = false;
	onAction?: (action: Action | null) => void;
	onChange?: () => void;

	constructor(
		private readonly theme: Theme,
		private readonly repo: string,
		current?: string,
	) {
		this.reloadSwarms();
		const index = current ? this.visible().findIndex((state) => state.spec.id === current) : -1;
		if (index >= 0) {
			this.cursor = index;
			this.view = "members";
		}
	}

	private visible(): SwarmState[] {
		return this.showAll ? this.swarms : this.swarms.filter((state) => state.spec.repo === this.repo);
	}

	reloadSwarms(): void {
		this.swarms = listSwarms();
		if (!this.visible().length && this.swarms.length) this.showAll = true;
	}

	async refresh(): Promise<void> {
		this.reloadSwarms();
		const target = this.visible()[this.cursor];
		if (target && this.view !== "swarms") this.selected = await snapshot(target.spec.id);
		this.onChange?.();
	}

	private members(): Member[] {
		return this.selected?.state.members ?? [];
	}

	handleInput(data: string): void {
		const list = this.view === "swarms" ? this.visible() : this.members();
		const id = this.selected?.state.spec.id;
		if (matchesKey(data, Key.escape) || data === "q") {
			if (this.view === "swarms") return this.onAction?.(null);
			this.view = this.view === "board" ? "members" : "swarms";
		} else if (matchesKey(data, Key.up) || data === "k") {
			if (this.view === "swarms") this.cursor = Math.max(0, this.cursor - 1);
			else this.memberCursor = Math.max(0, this.memberCursor - 1);
		} else if (matchesKey(data, Key.down) || data === "j") {
			if (this.view === "swarms") this.cursor = Math.min(list.length - 1, this.cursor + 1);
			else this.memberCursor = Math.min(list.length - 1, this.memberCursor + 1);
		} else if (matchesKey(data, Key.enter)) {
			if (this.view === "swarms" && list.length) {
				this.view = "members";
				this.memberCursor = 0;
				this.selected = undefined;
				void this.refresh();
			} else if (this.view === "members" && id) {
				const member = this.members()[this.memberCursor];
				if (member) this.onAction?.({ type: "attach", id, member: member.name });
			}
		} else if (data === "a" && this.view === "swarms") {
			this.showAll = !this.showAll;
			this.cursor = 0;
		} else if (data === "b" && this.view === "members") this.view = "board";
		else if (data === "l" && id) this.onAction?.({ type: "lead", id });
		else if ((data === "m" || data === "s" || data === "p") && this.view === "members" && id) {
			const member = this.members()[this.memberCursor];
			if (!member) return;
			if (data === "m") this.onAction?.({ type: "message", id, member: member.name });
			if (data === "s") this.onAction?.({ type: "stop", id, member: member.name });
			if (data === "p") {
				const permission = this.selected?.state.permissions.find((candidate) => candidate.from === member.name && candidate.state === "pending");
				if (permission) this.onAction?.({ type: "decide", id, permission: permission.id });
			}
		}
		this.onChange?.();
	}

	render(width: number): string[] {
		const t = this.theme;
		const lines: string[] = [];
		const push = (line: string) => lines.push(truncateToWidth(line, width));
		if (this.view === "swarms") {
			push(t.fg("accent", `Swarms ${this.showAll ? "(all repos)" : `in ${this.repo}`}`));
			const list = this.visible();
			if (!list.length) push(t.fg("muted", "No swarms yet. Start one with /leader <goal>."));
			list.forEach((state, index) => {
				const counts: Record<string, number> = {};
				for (const member of state.members) counts[member.state] = (counts[member.state] ?? 0) + 1;
				const summary = Object.entries(counts)
					.map(([name, count]) => t.fg(STATE_COLOR[name] ?? "text", `${count} ${name}`))
					.join(" ");
				const live = clientFor(state.spec.id) ? t.fg("success", "●") : t.fg("muted", "○");
				const row = `${live} ${state.spec.id}  ${state.spec.pattern}/g${state.generation}  ${summary || t.fg("dim", "no members")}  ${t.fg("muted", state.spec.goal.split("\n")[0])}`;
				push(index === this.cursor ? t.bg("selectedBg", `› ${row}`) : `  ${row}`);
			});
			push("");
			push(t.fg("dim", "↑↓ move · enter open · l lead from this session · a all repos · esc close"));
			return lines;
		}
		const snap = this.selected;
		if (!snap) return [t.fg("muted", "Loading…")];
		const { state } = snap;
		push(t.fg("accent", `Swarm ${state.spec.id} · ${state.status} · ${state.spec.pattern} g${state.generation}/${state.spec.maxGenerations} · ${state.spec.backend}${snap.live ? "" : " · daemon down"}`));
		push(t.fg("muted", state.spec.goal.split("\n")[0]));
		if (this.view === "board") {
			const rows = snap.board.slice(-Math.max(5, 40));
			for (const post of rows) push(`${t.fg("dim", `#${post.seq}`)} ${t.fg("accent", post.from)}${post.to ? t.fg("dim", ` → ${post.to}`) : ""} ${t.fg("muted", `[${post.kind}]`)} ${formatPost(post).split(": ").slice(1).join(": ").replace(/\s+/g, " ")}`);
			push("");
			push(t.fg("dim", "esc back"));
			return lines;
		}
		state.members.forEach((member, index) => {
			const status = t.fg(STATE_COLOR[member.state] ?? "text", member.state.padEnd(8));
			const fitness = member.fitness ? t.fg("success", ` ${member.fitness.score.toFixed(2)}`) : "";
			const attention = member.attention ? t.fg("warning", ` ⚑ ${member.attention}`) : "";
			const head = `${member.name.padEnd(20)} ${status} g${member.generation} ${t.fg("dim", `${member.model.split("/").pop()}:${member.thinking}`)}${fitness}${attention}`;
			push(index === this.memberCursor ? t.bg("selectedBg", `› ${head}`) : `  ${head}`);
			push(`    ${t.fg("muted", (member.lastPost ?? member.focus).replace(/\s+/g, " "))}`);
		});
		if (!state.members.length) push(t.fg("muted", "No members yet."));
		const pending = state.permissions.filter((permission) => permission.state === "pending");
		if (pending.length) push(t.fg("warning", `${pending.length} pending permission(s): ${pending.map((permission) => `${permission.from} (${permission.scope})`).join(", ")}`));
		push("");
		push(t.fg("dim", "↑↓ move · enter attach · m message · p decide permission · s stop · b board · l lead · esc back"));
		return lines;
	}

	invalidate(): void {}
}

async function attachMember(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	id: string,
	member: string,
	command: string[] | undefined,
	local: boolean,
): Promise<void> {
	const cli = `swarm attach ${id} ${member}`;
	// A local member already lives in its own Herdr tab: attaching only focuses it.
	if (local) {
		const focus = command?.length ? await pi.exec(command[0], command.slice(1)) : undefined;
		if (focus?.code !== 0) ctx.ui.notify(`${member} has no Herdr tab yet.${focus ? ` ${focus.stderr.trim()}` : ""}`, "warning");
		return;
	}
	if (process.env.HERDR_ENV !== "1") {
		ctx.ui.notify(`Run in another terminal: ${cli}${command ? `\n(${command.join(" ")})` : ""}`, "info");
		return;
	}
	const split = await pi.exec("herdr", ["pane", "split", "--current", "--direction", "right", "--cwd", ctx.cwd]);
	if (split.code !== 0) {
		ctx.ui.notify(`herdr pane split failed: ${split.stderr.trim()}\nRun: ${cli}`, "error");
		return;
	}
	const pane = (JSON.parse(split.stdout) as { result: { pane: { pane_id: string } } }).result.pane.pane_id;
	await pi.exec("herdr", ["pane", "rename", pane, `swarm ${member}`]);
	await pi.exec("herdr", ["pane", "run", pane, cli]);
}

export async function openPanel(pi: ExtensionAPI, ctx: ExtensionCommandContext, options: { current?: string; attachLeader: (id: string) => Promise<void> }): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("The swarm panel needs the TUI; use `swarm ls` and `swarm status` instead.", "warning");
		return;
	}
	const common = await pi.exec("git", ["-C", ctx.cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
	const repo = common.code === 0 ? common.stdout.trim().replace(/\/\.git$/, "") : ctx.cwd;
	let current = options.current;
	for (;;) {
		const action = await ctx.ui.custom<Action | null>((tui, theme, _keys, done) => {
			const panel = new SwarmPanel(theme as unknown as Theme, repo, current);
			let open = true;
			panel.onAction = (value) => {
				open = false;
				done(value);
			};
			panel.onChange = () => tui.requestRender();
			void (async () => {
				while (open) {
					await panel.refresh().catch(() => undefined);
					await sleep(2_000);
				}
			})();
			return {
				render: (width: number) => panel.render(width),
				handleInput: (data: string) => panel.handleInput(data),
				invalidate: () => panel.invalidate(),
			};
		});
		if (!action) return;
		current = action.id;
		const client = clientFor(action.id);
		try {
			if (action.type === "lead") {
				await options.attachLeader(action.id);
				ctx.ui.notify(`This session now leads swarm ${action.id}.`, "info");
				return;
			}
			if (!client) {
				ctx.ui.notify(`Swarm ${action.id}'s daemon is down; run \`swarm resume ${action.id}\`.`, "warning");
				continue;
			}
			if (action.type === "attach") {
				const state = await client.get<SwarmState & { attach: Record<string, string[]> }>("/state");
				await attachMember(pi, ctx, action.id, action.member, state.attach[action.member], state.spec.backend === "local");
				return;
			}
			if (action.type === "message") {
				const message = await ctx.ui.input(`Message ${action.member}`, "sent as the user");
				if (message?.trim()) await client.post("/post", { from: "user", kind: "status", to: action.member, text: message });
			} else if (action.type === "stop") {
				if (await ctx.ui.confirm(`Stop ${action.member}?`, "Its branch and board posts stay; the session ends.")) await client.post("/stop", { members: [action.member] });
			} else if (action.type === "decide") {
				const { permissions } = await client.get<{ permissions: { id: string; from: string; action: string; reason: string }[] }>("/permissions?state=pending");
				const permission = permissions.find((candidate) => candidate.id === action.permission);
				if (permission) {
					const approve = await ctx.ui.confirm(`${permission.from} asks`, `${permission.action}\n\nWhy: ${permission.reason}`);
					await client.post(`/permission/${permission.id}/decide`, { approve, by: "user" });
				}
			}
		} catch (error) {
			ctx.ui.notify(`swarm: ${(error as Error).message}`, "error");
		}
	}
}

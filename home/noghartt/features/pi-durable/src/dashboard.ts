import { homedir } from "node:os";
import {
	Container,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	type SelectItem,
	SelectList,
	type SelectListTheme,
	Spacer,
	Text,
} from "@earendil-works/pi-tui";
import { DynamicBorder } from "#pi/index.js";
import { theme } from "#pi/modes/interactive/theme/theme.js";
import { isSessionOpen, listAllSessions, type SessionListing } from "./sessions.ts";

/** One session as the dashboard shows it. */
export interface DashboardRow {
	readonly session: SessionListing;
	readonly open: boolean;
	readonly self: boolean;
}

const REFRESH_MS = 2000;

function age(date: Date): string {
	const seconds = Math.max(0, Math.round((Date.now() - date.getTime()) / 1000));
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
	if (seconds < 86_400) return `${Math.round(seconds / 3600)}h`;
	return `${Math.round(seconds / 86_400)}d`;
}

function count(value: number, noun: string): string {
	return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

function shortPath(path: string): string {
	const home = homedir();
	return path.startsWith(home) ? `~${path.slice(home.length)}` : path || "(unknown directory)";
}

/** Every session with whether a process holds it; the current one is marked. */
export async function loadDashboard(current: string | undefined): Promise<DashboardRow[]> {
	const sessions = await listAllSessions();
	return Promise.all(
		sessions.map(async (session) => ({
			session,
			self: session.path === current,
			open: session.path === current || (await isSessionOpen(session.path)),
		})),
	);
}

function status(row: DashboardRow): { icon: string; text: string } {
	const live = row.session.live;
	if (row.self) return { icon: theme.fg("accent", "◆"), text: "this session" };
	if (!row.open) return { icon: theme.fg("dim", "○"), text: "closed" };
	if (live?.busy === true) {
		const agents = live.running > 1 ? ` (${live.running} agents)` : "";
		return { icon: theme.fg("warning", "●"), text: `working${agents}` };
	}
	return { icon: theme.fg("success", "●"), text: "open, idle" };
}

/**
 * Projects (session directories) with their sessions, newest activity first. Open sessions show what they are doing,
 * as their processes report it in meta.json.
 */
function items(rows: readonly DashboardRow[]): { items: SelectItem[]; search: Map<string, string> } {
	const search = new Map<string, string>();
	const projects = new Map<string, DashboardRow[]>();
	for (const row of rows) {
		const list = projects.get(row.session.cwd) ?? [];
		list.push(row);
		projects.set(row.session.cwd, list);
	}
	const rank = (list: DashboardRow[]) =>
		Math.max(...list.map((row) => (row.open ? 1e15 : 0) + row.session.modified.getTime()));
	const ordered = [...projects.entries()].sort((left, right) => rank(right[1]) - rank(left[1]));
	const result: SelectItem[] = [];
	for (const [cwd, list] of ordered) {
		const open = list.filter((row) => row.open).length;
		search.set(`project:${cwd}`, shortPath(cwd));
		result.push({
			value: `project:${cwd}`,
			label: theme.bold(shortPath(cwd)),
			description: `${list.length} session${list.length === 1 ? "" : "s"}${open > 0 ? `, ${open} open` : ""}`,
		});
		list.sort((left, right) => Number(right.open) - Number(left.open) || right.session.modified.getTime() - left.session.modified.getTime());
		for (const row of list) {
			const { icon, text } = status(row);
			const live = row.open ? row.session.live : undefined;
			const title = (row.session.name ?? row.session.firstMessage).replace(/\s+/g, " ");
			const details = [
				text,
				live === undefined ? count(row.session.messageCount, "message") : count(live.conversations, "conversation"),
				live?.watchers ? count(live.watchers, "watcher") : undefined,
				live?.model,
				live === undefined ? undefined : `$${live.cost.toFixed(2)}`,
				`${age(row.session.modified)} ago`,
				live?.activity,
			].filter(Boolean);
			search.set(row.session.path, `${shortPath(cwd)} ${title} ${details.join(" ")} ${row.session.id}`);
			result.push({ value: row.session.path, label: `  ${icon} ${title}`, description: details.join(" · ") });
		}
	}
	return { items: result, search };
}

const SELECT_THEME: SelectListTheme = {
	selectedPrefix: (text) => theme.fg("accent", text),
	selectedText: (text) => theme.fg("accent", text),
	description: (text) => theme.fg("muted", text),
	scrollInfo: (text) => theme.fg("dim", text),
	noMatch: (text) => theme.fg("warning", text),
};

/**
 * Every pi-durable session on this machine by project, refreshed while shown: which are open, which work, on what
 * model, at what cost. Enter opens one (a project row filters to its sessions); Esc closes.
 */
export class DashboardComponent extends Container implements Focusable {
	readonly #input = new Input();
	readonly #listContainer = new Container();
	readonly #summary = new Text("", 1, 0);
	readonly #current: string | undefined;
	readonly #onSelect: (row: DashboardRow) => void;
	readonly #onCancel: () => void;
	readonly #requestRender: () => void;
	#rows: DashboardRow[] = [];
	#items: SelectItem[] = [];
	#search = new Map<string, string>();
	#list: SelectList;
	#timer: NodeJS.Timeout | undefined;
	#focused = false;
	#disposed = false;

	constructor(
		current: string | undefined,
		onSelect: (row: DashboardRow) => void,
		onCancel: () => void,
		requestRender: () => void,
	) {
		super();
		this.#current = current;
		this.#onSelect = onSelect;
		this.#onCancel = onCancel;
		this.#requestRender = requestRender;
		this.#list = this.#build([]);
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold("Sessions and agents")), 1, 0));
		this.addChild(this.#summary);
		this.addChild(this.#input);
		this.addChild(new Spacer(1));
		this.addChild(this.#listContainer);
		this.addChild(new Text(theme.fg("dim", "enter open · type to filter · esc close"), 1, 0));
		this.addChild(new DynamicBorder());
		void this.refresh();
	}

	get focused(): boolean {
		return this.#focused;
	}
	set focused(value: boolean) {
		this.#focused = value;
		this.#input.focused = value;
	}

	/** Show `message` in place of the summary until the next refresh. */
	notify(message: string): void {
		this.#summary.setText(theme.fg("warning", message));
		this.#requestRender();
	}

	/** Stop refreshing; call when the dashboard leaves the screen. */
	dispose(): void {
		this.#disposed = true;
		if (this.#timer !== undefined) clearTimeout(this.#timer);
	}

	async refresh(): Promise<void> {
		if (this.#disposed) return;
		try {
			this.#rows = await loadDashboard(this.#current);
			({ items: this.#items, search: this.#search } = items(this.#rows));
			const open = this.#rows.filter((row) => row.open);
			const busy = open.filter((row) => row.session.live?.busy === true).length;
			this.#summary.setText(
				theme.fg(
					"muted",
					`${count(this.#rows.length, "session")} in ${count(new Set(this.#rows.map((row) => row.session.cwd)).size, "project")} · ${open.length} open · ${busy} working`,
				),
			);
			this.#filter(true);
			this.#requestRender();
		} finally {
			if (!this.#disposed) this.#timer = setTimeout(() => void this.refresh(), REFRESH_MS);
		}
	}

	handleInput(data: string): void {
		const keybindings = getKeybindings();
		const forwarded = ["tui.select.up", "tui.select.down", "tui.select.confirm", "tui.select.cancel"] as const;
		if (forwarded.some((action) => keybindings.matches(data, action))) {
			this.#list.handleInput(data);
			return;
		}
		this.#input.handleInput(data);
		this.#filter(false);
	}

	/** Rebuild the list for the filter, keeping the selection on the same row across refreshes. */
	#filter(keepSelection: boolean): void {
		const selected = keepSelection ? this.#list.getSelectedItem()?.value : undefined;
		const query = this.#input.getValue();
		const shown =
			query.length === 0 ? this.#items : fuzzyFilter(this.#items, query, (item) => this.#search.get(item.value) ?? item.value);
		this.#list = this.#build(shown);
		const index = selected === undefined ? -1 : shown.findIndex((item) => item.value === selected);
		if (index >= 0) this.#list.setSelectedIndex(index);
		else {
			// Start on the first session, not a project heading.
			const first = shown.findIndex((item) => !item.value.startsWith("project:"));
			if (first > 0) this.#list.setSelectedIndex(first);
		}
	}

	#build(shown: SelectItem[]): SelectList {
		const list = new SelectList(shown, 14, SELECT_THEME, { minPrimaryColumnWidth: 30, maxPrimaryColumnWidth: 60 });
		list.onSelect = (item) => {
			if (item.value.startsWith("project:")) {
				this.#input.setValue(shortPath(item.value.slice("project:".length)));
				this.#filter(false);
				this.#requestRender();
				return;
			}
			const row = this.#rows.find((candidate) => candidate.session.path === item.value);
			if (row !== undefined) this.#onSelect(row);
		};
		list.onCancel = this.#onCancel;
		this.#listContainer.clear();
		this.#listContainer.addChild(list);
		return list;
	}
}

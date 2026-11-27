import {
	Container,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	Markdown,
	type SelectItem,
	SelectList,
	type SelectListTheme,
	Spacer,
	Text,
	TruncatedText,
} from "@earendil-works/pi-tui";
import type { ConversationId } from "@earendil-works/pi-durable";
import { DynamicBorder, getMarkdownTheme } from "#pi/index.js";
import { theme } from "#pi/modes/interactive/theme/theme.js";
import type { SwarmBoardMember, SwarmBoardView } from "./swarm.ts";

const REFRESH_MS = 1000;

const SELECT_THEME: SelectListTheme = {
	selectedPrefix: (text) => theme.fg("accent", text),
	selectedText: (text) => theme.fg("accent", text),
	description: (text) => theme.fg("muted", text),
	scrollInfo: (text) => theme.fg("dim", text),
	noMatch: (text) => theme.fg("warning", text),
};

const flat = (text: string) => text.replace(/\s+/g, " ").trim();

function icon(member: SwarmBoardMember): string {
	if (member.state === "killed") return theme.fg("dim", "✕");
	if (member.state === "working") return theme.fg("warning", "●");
	if (member.finished) return theme.fg("success", "✓");
	return theme.fg("muted", "○");
}

/** A thread's state from its members: failed (killed), working, done, or waiting on a peer. */
function threadState(members: readonly SwarmBoardMember[]): string {
	if (members.length === 0) return theme.fg("dim", "no members");
	if (members.some((member) => member.state === "working")) return theme.fg("warning", "working");
	if (members.every((member) => member.finished || member.state === "killed")) return theme.fg("success", "done");
	return theme.fg("muted", "waiting");
}

/**
 * The swarm's board, refreshed while shown: an overview of the goal and threads, then the roster and the posts (newest
 * first) in one filterable list. Enter on a member opens its conversation (an Antigravity member, which has none, shows its latest post); on a post, shows
 * it in full below.
 */
export class SwarmBoardComponent extends Container implements Focusable {
	readonly #input = new Input();
	readonly #header = new Container();
	readonly #listContainer = new Container();
	readonly #message = new Container();
	readonly #load: () => Promise<SwarmBoardView | undefined>;
	readonly #onOpen: (id: ConversationId) => void;
	readonly #onCancel: () => void;
	readonly #requestRender: () => void;
	#board: SwarmBoardView | undefined;
	#items: SelectItem[] = [];
	#search = new Map<string, string>();
	#list: SelectList;
	#shown: number | undefined;
	#timer: NodeJS.Timeout | undefined;
	#focused = false;
	#disposed = false;

	constructor(
		load: () => Promise<SwarmBoardView | undefined>,
		onOpen: (id: ConversationId) => void,
		onCancel: () => void,
		requestRender: () => void,
	) {
		super();
		this.#load = load;
		this.#onOpen = onOpen;
		this.#onCancel = onCancel;
		this.#requestRender = requestRender;
		this.#list = this.#build([]);
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(this.#header);
		this.addChild(this.#input);
		this.addChild(new Spacer(1));
		this.addChild(this.#listContainer);
		this.addChild(this.#message);
		this.addChild(
			new Text(theme.fg("dim", "enter: open a member's conversation, or show a post · type to filter · esc close"), 1, 0),
		);
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

	dispose(): void {
		this.#disposed = true;
		if (this.#timer !== undefined) clearTimeout(this.#timer);
	}

	async refresh(): Promise<void> {
		if (this.#disposed) return;
		try {
			const board = await this.#load();
			const changed = JSON.stringify(board) !== JSON.stringify(this.#board);
			this.#board = board;
			if (changed) {
				this.#syncHeader();
				this.#items = this.#toItems();
				this.#filter(true);
				this.#syncMessage();
				this.#requestRender();
			}
		} catch (error) {
			// A failed load keeps the last board; the next refresh tries again.
			this.#header.clear();
			this.#header.addChild(new Text(theme.fg("error", `Board unavailable: ${error instanceof Error ? error.message : String(error)}`), 1, 0));
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

	#syncHeader(): void {
		this.#header.clear();
		const board = this.#board;
		if (board === undefined) {
			this.#header.addChild(new Text(theme.fg("muted", "No swarm in this session; start one with /swarm <task>."), 1, 0));
			return;
		}
		const status =
			board.status === "running" ? theme.fg("warning", "running") : board.status === "done" ? theme.fg("success", "done") : theme.fg("dim", "ended");
		const live = board.members.filter((member) => member.state !== "killed");
		const working = live.filter((member) => member.state === "working").length;
		this.#header.addChild(
			new TruncatedText(theme.fg("accent", theme.bold(`Swarm: ${board.title ?? "(untitled)"}`)) + theme.fg("dim", " · ") + status, 1, 0),
		);
		this.#header.addChild(
			new TruncatedText(
				theme.fg("muted", `${live.length} members, ${working} at work · ${board.posts.length} posts · coordinator #${board.coordinator}`),
				1,
				0,
			),
		);
		const goal = board.goal ?? board.task;
		if (goal !== undefined) this.#header.addChild(new TruncatedText(theme.fg("muted", `Goal: ${flat(goal)}`), 1, 0));
		if (board.threads.length > 0) {
			const finished = board.members.filter((member) => member.finished).length;
			this.#header.addChild(
				new TruncatedText(theme.fg("accent", `Overview · ${finished} of ${board.members.length} done`), 1, 0),
			);
			for (const thread of board.threads) {
				const members = board.members.filter((member) => thread.members.includes(member.name));
				const roster = members.map((member) => `${icon(member)} ${member.name}`).join("  ");
				this.#header.addChild(
					new TruncatedText(`  ${thread.title} ${theme.fg("dim", "·")} ${threadState(members)}  ${roster}`, 1, 0),
				);
			}
		}
		this.#header.addChild(new Spacer(1));
	}

	#toItems(): SelectItem[] {
		const board = this.#board;
		this.#search.clear();
		if (board === undefined) return [];
		const items: SelectItem[] = [];
		for (const member of board.members) {
			const traits = [
				member.finished && member.state !== "working" ? "done" : member.state,
				member.profile,
				member.model,
				member.branch ?? "main checkout",
				`read #${member.lastRead}`,
			].filter(Boolean);
			// An Antigravity member has no conversation to open: Enter shows its latest post.
			const value = member.conversationId === undefined ? `a:${member.name}` : `m:${member.conversationId}`;
			this.#search.set(value, `${member.name} ${traits.join(" ")}`);
			items.push({ value, label: `${icon(member)} ${member.name}`, description: traits.join(" · ") });
		}
		for (const post of [...board.posts].reverse()) {
			const value = `p:${post.seq}`;
			this.#search.set(value, `#${post.seq} ${post.from} ${post.text}`);
			items.push({ value, label: `#${post.seq} ${post.from}`, description: flat(post.text) });
		}
		return items;
	}

	#syncMessage(): void {
		this.#message.clear();
		const post = this.#board?.posts.find((candidate) => candidate.seq === this.#shown);
		if (post === undefined) return;
		this.#message.addChild(new Spacer(1));
		this.#message.addChild(
			new Text(theme.fg("accent", `#${post.seq} from ${post.from}, ${new Date(post.time).toLocaleTimeString()}`), 1, 0),
		);
		this.#message.addChild(new Markdown(post.text, 1, 0, getMarkdownTheme()));
	}

	#filter(keepSelection: boolean): void {
		const selected = keepSelection ? this.#list.getSelectedItem()?.value : undefined;
		const query = this.#input.getValue();
		const shown =
			query.length === 0 ? this.#items : fuzzyFilter(this.#items, query, (item) => this.#search.get(item.value) ?? item.value);
		this.#list = this.#build(shown);
		const index = selected === undefined ? -1 : shown.findIndex((item) => item.value === selected);
		if (index >= 0) this.#list.setSelectedIndex(index);
	}

	#build(shown: SelectItem[]): SelectList {
		const list = new SelectList(shown, 12, SELECT_THEME, { minPrimaryColumnWidth: 18, maxPrimaryColumnWidth: 28 });
		list.onSelect = (item) => {
			if (item.value.startsWith("m:")) return this.#onOpen(Number(item.value.slice(2)) as ConversationId);
			const seq = item.value.startsWith("a:")
				? this.#board?.posts.findLast((post) => post.from === item.value.slice(2))?.seq
				: Number(item.value.slice(2));
			if (seq === undefined) return;
			this.#shown = this.#shown === seq ? undefined : seq;
			this.#syncMessage();
			this.#requestRender();
		};
		list.onCancel = this.#onCancel;
		this.#listContainer.clear();
		this.#listContainer.addChild(list);
		return list;
	}
}

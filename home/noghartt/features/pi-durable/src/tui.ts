import type { AssistantMessage, ModelThinkingLevel, ToolResultMessage, Usage, UserMessage } from "@earendil-works/pi-ai";
import type {
	ConversationId,
	EntryRecord,
	InboxState,
	LiveState,
	TaskGraph,
	TaskGraphNode,
	UsageState,
} from "@earendil-works/pi-durable";
import {
	Box,
	CombinedAutocompleteProvider,
	type Component,
	Container,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	Markdown,
	ProcessTerminal,
	ScrollView,
	type SelectItem,
	SelectList,
	type SelectListTheme,
	Spacer,
	setCapabilityOverrides,
	setKeybindings,
	type SlashCommand,
	Text,
	TruncatedText,
	TuiAltScreen,
	VStack,
} from "@earendil-works/pi-tui";
import {
	AssistantMessageComponent,
	copyToClipboard,
	CustomEditor,
	DynamicBorder,
	getAgentDir,
	getMarkdownTheme,
	SettingsManager,
	initTheme,
	keyText,
	LoginDialogComponent,
	parseSkillBlock,
	SessionSelectorComponent,
	SkillInvocationMessageComponent,
	ToolExecutionComponent,
	type ToolRenderers,
	UserMessageComponent,
} from "#pi/index.js";
import { branchTree } from "./branches.ts";
import { KeybindingsManager } from "#pi/core/keybindings.js";
import { createAllToolRenderers } from "#pi/core/tools/renderers/index.js";
import { formatTokens } from "#pi/modes/interactive/components/footer.js";
import { type StatusIndicator, WorkingStatusIndicator } from "#pi/modes/interactive/components/status-indicator.js";
import { getEditorTheme, theme } from "#pi/modes/interactive/theme/theme.js";
import { InteractiveThemeController } from "#pi/modes/interactive/theme/theme-controller.js";
import { ReferenceAutocomplete, type ReferenceSources } from "./completions.ts";
import { inRex, RexStatus } from "./rex.ts";
import { BtwComponent } from "./btw.ts";
import { DashboardComponent, type DashboardRow } from "./dashboard.ts";
import { ReportPanel, StatusComponent } from "./status.ts";
import { validAccountName } from "./accounts.ts";
import {
	ACCOUNTS_HINT,
	accountsCompletions,
	accountsLines,
	dialogInteraction,
	parseAccountsCommand,
} from "./accounts-view.ts";
import { SwarmBoardComponent } from "./swarm-board.ts";
import {
	type ActivityItem,
	agentOf,
	type DurableView,
	isInput,
	lastAnswer,
	type LoginTarget,
	type OpenDurableResult,
	userText,
} from "./runtime.ts";
import { listAllSessions, listSessions, type SessionTarget, writeMeta } from "./sessions.ts";
import { MESSAGE_KIND, type NoteData, REPORT_KIND } from "./state.ts";

const THINKING_LEVELS: readonly ModelThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

const SELECT_THEME: SelectListTheme = {
	selectedPrefix: (text) => theme.fg("accent", text),
	selectedText: (text) => theme.fg("accent", text),
	description: (text) => theme.fg("muted", text),
	scrollInfo: (text) => theme.fg("dim", text),
	noMatch: (text) => theme.fg("warning", text),
};

/** A filterable list in place of the editor. */
class ListSelector extends Container implements Focusable {
	readonly #input = new Input();
	readonly #listContainer = new Container();
	readonly #items: SelectItem[];
	readonly #onSelect: (value: string) => void;
	readonly #onCancel: () => void;
	#list: SelectList;
	#focused = false;

	constructor(title: string, items: SelectItem[], onSelect: (value: string) => void, onCancel: () => void) {
		super();
		this.#items = items;
		this.#onSelect = onSelect;
		this.#onCancel = onCancel;
		this.#list = this.#build(items);
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
		this.addChild(this.#input);
		this.addChild(new Spacer(1));
		this.addChild(this.#listContainer);
		this.addChild(new DynamicBorder());
	}

	get focused(): boolean {
		return this.#focused;
	}
	set focused(value: boolean) {
		this.#focused = value;
		this.#input.focused = value;
	}

	handleInput(data: string): void {
		const keybindings = getKeybindings();
		const forwarded = ["tui.select.up", "tui.select.down", "tui.select.confirm", "tui.select.cancel"] as const;
		if (forwarded.some((action) => keybindings.matches(data, action))) {
			this.#list.handleInput(data);
			return;
		}
		this.#input.handleInput(data);
		const query = this.#input.getValue();
		const filtered =
			query.length === 0 ? this.#items : fuzzyFilter(this.#items, query, (item) => `${item.label} ${item.value}`);
		this.#list = this.#build(filtered);
	}

	#build(items: SelectItem[]): SelectList {
		const list = new SelectList(items, 10, SELECT_THEME);
		list.onSelect = (item) => this.#onSelect(item.value);
		list.onCancel = this.#onCancel;
		this.#listContainer.clear();
		this.#listContainer.addChild(list);
		return list;
	}
}

/** The summary that replaced earlier context: collapsed to one line until expanded. */
class CompactionComponent extends Box {
	readonly #summary: string;

	constructor(summary: string, expanded: boolean) {
		super(1, 1, (text) => theme.bg("customMessageBg", text));
		this.#summary = summary;
		this.setExpanded(expanded);
	}

	setExpanded(expanded: boolean): void {
		this.clear();
		this.addChild(new Text(theme.fg("customMessageLabel", theme.bold("[compaction]")), 0, 0));
		this.addChild(new Spacer(1));
		this.addChild(
			expanded
				? new Markdown(this.#summary, 0, 0, getMarkdownTheme(), {
						color: (text: string) => theme.fg("customMessageText", text),
					})
				: new Text(
						theme.fg("customMessageText", "Earlier context summarized (") +
							theme.fg("dim", keyText("app.tools.expand")) +
							theme.fg("customMessageText", " to expand)"),
						0,
						0,
					),
		);
	}
}

/** A report (a subagent's answer, a watcher's event) or another agent's message: collapsed to its first lines. */
class NoteComponent extends Box {
	readonly #title: string;
	readonly #text: string;

	constructor(kind: string, data: NoteData, expanded: boolean) {
		super(1, 1, (text) => theme.bg("customMessageBg", text));
		this.#title = `${kind === REPORT_KIND ? "report" : "message"} from ${data.from}`;
		this.#text = data.text;
		this.setExpanded(expanded);
	}

	setExpanded(expanded: boolean): void {
		this.clear();
		this.addChild(new Text(theme.fg("customMessageLabel", theme.bold(`[${this.#title}]`)), 0, 0));
		this.addChild(new Spacer(1));
		const lines = this.#text.split("\n");
		const shown = expanded || lines.length <= 6 ? this.#text : lines.slice(0, 6).join("\n");
		this.addChild(
			new Markdown(shown, 0, 0, getMarkdownTheme(), { color: (text: string) => theme.fg("customMessageText", text) }),
		);
		if (shown !== this.#text) {
			this.addChild(
				new Text(theme.fg("dim", `… ${lines.length - 6} more lines (${keyText("app.tools.expand")} to expand)`), 0, 0),
			);
		}
	}
}

/** Reference blocks `@session:`/`@agent:`/`@label:` attached to an input; the transcript shows only their count. */
const REFERENCE_BLOCKS = /\n\n(<reference to="[^"]*"[\s\S]*)$/u;

/** What a parked or running tool call shows before its result: a subagent's progress, or its streamed output. */
function progressText(details: unknown, output: string | undefined): string | undefined {
	const value = details as
		| {
				conversationId?: number;
				name?: string;
				background?: boolean;
				runner?: string;
				parallel?: Array<{ name: string; agent: string; status: string; conversationId?: number }>;
		  }
		| undefined;
	if (value?.parallel !== undefined) {
		const done = value.parallel.filter((child) => child.status === "done" || child.status === "failed").length;
		const marks: Record<string, string> = { queued: "·", running: "…", done: "✓", failed: "✗" };
		return [
			`${done}/${value.parallel.length} subagents finished. /agents switches to one.`,
			...value.parallel.map(
				(child) =>
					`${marks[child.status] ?? "?"} ${child.name} (${child.agent})${child.conversationId === undefined ? "" : ` #${child.conversationId}`} ${child.status}`,
			),
		].join("\n");
	}
	if (output !== undefined) return output;
	if (value?.runner === "antigravity") return `Antigravity subagent ${value.name ?? ""} is working (agy).`;
	if (value?.conversationId !== undefined) {
		return `Subagent ${value.name ?? ""} #${value.conversationId} is working. /agents switches to it.`;
	}
	return undefined;
}

interface Handlers {
	submit(text: string): void;
	followUp(text: string): void;
	abort(): void;
	exit(): void;
	selectModel(): void;
	cycleThinking(): void;
}

class DurableTui {
	static readonly #renderers: Record<string, ToolRenderers> = createAllToolRenderers();
	readonly #ui: TuiAltScreen;
	readonly #chat = new Container();
	readonly #tasks = new Container();
	readonly #queue = new Container();
	readonly #notices = new Container();
	readonly #footer = new Container();
	readonly #footerStats = new Text("", 1, 0);
	readonly #footerHints = new Text("", 1, 0);
	readonly #editorContainer = new Container();
	readonly #editor: CustomEditor;
	readonly #cwd: string;
	/** The newest card per call ID; provider call IDs may repeat across turns. */
	readonly #tools = new Map<string, ToolExecutionComponent>();
	/** Every card shown, also older ones whose call ID a later turn reused. */
	readonly #cards: ToolExecutionComponent[] = [];
	/** Call IDs whose cards the streaming answer created; its entry takes them over. */
	readonly #streamingCalls = new Set<string>();
	readonly #summaries: Array<CompactionComponent | SkillInvocationMessageComponent | NoteComponent> = [];
	readonly #activity = new Container();
	/** A mounted component that refreshes itself until it leaves the screen. */
	#mounted: { dispose(): void } | undefined;
	// What mount() last showed, and prompts layered over it: a login can run while an approval is asked, and
	// either may finish first, so neither may replace or restore over the other.
	#base: { component: Component; focus: Component } | undefined;
	readonly #layers: { component: Component; focus: Component }[] = [];
	readonly #waiting: { title: string }[] = [];
	/** Tool output and summaries shown in full; toggled like pi. */
	#expanded = false;
	#renderedEntryIds: number[] = [];
	#streaming: AssistantMessageComponent | undefined;
	#indicator: StatusIndicator | undefined;
	#statusText = "";
	/** Set when the transcript was rebuilt: the next render repaints the screen and shows the end. */
	#rebuilt = false;
	#transcript: ScrollView;
	/** Warnings and errors in full above the editor; collapsed, the footer only counts them. Toggled by /notices. */
	#noticesShown = false;
	/** Notices up to this ID were dismissed with /notices clear. */
	#noticesClearedThrough = 0;
	#noticeCounts = "";
	#lastView: DurableView | undefined;
	#rex: RexStatus | undefined;

	constructor(cwd: string, handlers: Handlers) {
		this.#cwd = cwd;
		this.#ui = new TuiAltScreen(new ProcessTerminal(), false, getAgentDir());
		const keybindings = KeybindingsManager.create();
		setKeybindings(keybindings);
		this.#editor = new CustomEditor(this.#ui, getEditorTheme(), keybindings, {
			paddingX: 1,
			embedWorkingStatus: true,
		});
		this.#editor.onSubmit = handlers.submit;
		this.#editor.onEscape = handlers.abort;
		this.#editor.onCtrlD = handlers.exit;
		this.#editor.onAction("app.clear", handlers.exit);
		this.#editor.onAction("app.model.select", handlers.selectModel);
		this.#editor.onAction("app.thinking.cycle", handlers.cycleThinking);
		this.#editor.onAction("app.tools.expand", () => {
			this.#expanded = !this.#expanded;
			for (const component of [...this.#cards, ...this.#summaries]) component.setExpanded(this.#expanded);
			this.#ui.requestRender();
		});
		this.#editor.onAction("app.message.followUp", () => {
			const text = this.#editor.getText().trim();
			if (!text) return;
			this.#editor.setText("");
			handlers.followUp(text);
		});

		this.#editorContainer.addChild(this.#editor);
		this.#footer.addChild(this.#footerStats);
		this.#footer.addChild(this.#footerHints);
		// One empty line between the transcript and everything below it.
		const content = new Container();
		content.addChild(this.#chat);
		content.addChild(new Spacer(1));
		const transcript = new ScrollView(content, { follow: "end", primary: true, overscroll: "chain" });
		this.#transcript = transcript;
		const dock = new VStack([
			{ component: this.#tasks, shrink: 1, minSize: 0 },
			{ component: this.#activity, shrink: 1, minSize: 0 },
			{ component: this.#queue, shrink: 1, minSize: 0 },
			{ component: this.#notices, shrink: 1, minSize: 0 },
			{ component: this.#editorContainer, shrink: 1, minSize: 3 },
			{ component: this.#footer, shrink: 1, minSize: 0 },
		]);
		for (const component of [
			this.#chat,
			this.#tasks,
			this.#activity,
			this.#queue,
			this.#notices,
			this.#editorContainer,
			this.#footer,
		]) {
			this.#ui.addChild(component);
		}
		this.#ui.setLayoutRoot(
			new VStack([
				{ component: transcript, basis: 0, grow: 1, shrink: 1, minSize: 1 },
				{ component: dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
			]),
		);
		this.#ui.setFocus(this.#editor);
	}

	get ui(): TuiAltScreen {
		return this.#ui;
	}

	start(): void {
		this.#ui.start();
		// Inside Rex, what the agent is doing shows on its tab and in the session picker (src/rex.ts).
		if (inRex()) this.#rex = new RexStatus((data) => this.#ui.terminal.write(data));
		if (this.#lastView !== undefined) this.#rex?.update(this.#lastView);
	}

	/** Something waits on the user (an approval, a login); the returned release ends it. */
	waiting(title: string): () => void {
		const entry = { title };
		this.#waiting.push(entry);
		this.#rex?.approval(title);
		return () => {
			const index = this.#waiting.indexOf(entry);
			if (index < 0) return;
			this.#waiting.splice(index, 1);
			this.#rex?.approval(this.#waiting.at(-1)?.title);
		};
	}

	stop(): void {
		this.#rex?.close();
		this.#rex = undefined;
		this.#mounted?.dispose();
		this.#discardTools();
		this.#indicator?.dispose();
		this.#ui.stop();
	}

	/** Finish every card: a running bash card keeps a timer until it gets a final result. */
	#discardTools(): void {
		for (const component of this.#cards) component.updateResult({ content: [], isError: false }, false);
		this.#cards.length = 0;
		this.#tools.clear();
		this.#streamingCalls.clear();
	}

	/** Show `component` in place of the editor; `focus` is the part that takes keys, as in pi's selectors. */
	mount(component: Component, focus: Component = component): void {
		this.#mounted?.dispose();
		this.#mounted = "dispose" in component ? (component as unknown as { dispose(): void }) : undefined;
		this.#base = { component, focus };
		if (this.#layers.length === 0) this.#show(component, focus);
	}

	/** Show `component` over whatever is shown, keeping it; the returned close reveals what is under it. */
	layer(component: Component, focus: Component = component): () => void {
		const entry = { component, focus };
		this.#layers.push(entry);
		this.#show(component, focus);
		return () => {
			const index = this.#layers.indexOf(entry);
			if (index < 0) return;
			this.#layers.splice(index, 1);
			if (index !== this.#layers.length) return;
			const top = this.#layers.at(-1) ?? this.#base ?? { component: this.#editor, focus: this.#editor };
			this.#show(top.component, top.focus);
		};
	}

	#show(component: Component, focus: Component): void {
		this.#editorContainer.clear();
		this.#editorContainer.addChild(component);
		this.#ui.setFocus(focus);
		this.#ui.requestRender();
	}

	get editor(): CustomEditor {
		return this.#editor;
	}

	restoreEditor(): void {
		this.mount(this.#editor);
	}

	setCommands(commands: SlashCommand[], references: ReferenceSources): void {
		// fd is on the wrapper's PATH; it also drives @ file completion.
		const files = new CombinedAutocompleteProvider(commands, this.#cwd, "fd");
		this.#editor.setAutocompleteProvider(new ReferenceAutocomplete(files, references));
	}

	/** Shows or hides warnings and errors; `clear` dismisses those so far. */
	notices(action: "toggle" | "clear"): void {
		const view = this.#lastView;
		if (action === "clear") {
			for (const item of view?.notices ?? []) {
				this.#noticesClearedThrough = Math.max(this.#noticesClearedThrough, item.id);
			}
		} else this.#noticesShown = !this.#noticesShown;
		if (view === undefined) return;
		this.#syncNotices(view);
		this.#syncFooter(view);
		this.#ui.requestRender();
	}

	apply(view: DurableView): void {
		this.#lastView = view;
		this.#rex?.update(view);
		const live = (view.conversation.docs["pi.live"] ?? {}) as LiveState;
		this.#syncTranscript(view.conversation.entries);
		const message = live.generation?.message as AssistantMessage | undefined;
		// A partial without its entry was dropped, for example by a retry: render the transcript again.
		if (message === undefined && this.#streaming !== undefined) this.#rebuild(view.conversation.entries);
		if (message !== undefined) this.#syncStreaming(message);
		for (const slot of live.tools ?? []) {
			if (slot.status === "pending") continue;
			const component = this.#tool(slot.name, slot.callId);
			component.setArgsComplete();
			// Parked calls (a subagent's answer, parallel subagents) are still at work.
			if (slot.status === "done") continue;
			component.markExecutionStarted();
			const text = progressText(slot.details, slot.output);
			if (text !== undefined) {
				component.updateResult({ content: [{ type: "text", text }], details: slot.details, isError: false }, true);
			}
		}
		this.#syncTasks(view.tasks);
		this.#syncActivity(view.activity);
		this.#syncQueue((view.conversation.docs["pi.inbox"] ?? { items: [] }) as InboxState);
		this.#syncNotices(view);
		this.#editor.borderColor = theme.getThinkingBorderColor(agentOf(view.conversation).thinkingLevel ?? "off");
		this.#syncStatus(live);
		this.#syncFooter(view);
		if (this.#rebuilt) this.#transcript.scrollToEnd();
		this.#ui.requestRender(this.#rebuilt);
		this.#rebuilt = false;
	}

	#syncTasks(graph: TaskGraph | undefined): void {
		this.#tasks.clear();
		if (graph === undefined) return;
		const nodes = Object.values(graph.tasks);
		const lines: string[] = [theme.fg("accent", `Tasks (${nodes.length} live, /tasks to hide)`)];
		// A conversation-owned task sits under the task that owns its conversation, when that task is live.
		const owned = new Set(nodes.flatMap((node) => node.conversations));
		const children = (node: TaskGraphNode) =>
			nodes.filter(
				(candidate) =>
					candidate.owner === node.id ||
					(candidate.owner === undefined && node.conversations.includes(candidate.conversationId)),
			);
		const visit = (node: TaskGraphNode, depth: number): void => {
			lines.push(`${"  ".repeat(depth + 1)}${describeTask(node)}`);
			for (const child of children(node)) visit(child, depth + 1);
		};
		for (const node of nodes) {
			if (node.owner === undefined && !owned.has(node.conversationId)) visit(node, 0);
		}
		for (const line of lines) this.#tasks.addChild(new TruncatedText(theme.fg("muted", line), 1, 0));
	}

	#syncActivity(activity: readonly ActivityItem[]): void {
		this.#activity.clear();
		if (activity.length === 0) return;
		const working = activity.filter((item) => item.kind === "conversation").length;
		const watchers = activity.filter((item) => item.kind === "watcher").length;
		const counts = [
			activity.some((item) => item.kind === "swarm") ? "swarm running" : undefined,
			working > 0 ? `${working} at work` : undefined,
			watchers > 0 ? `${watchers} watching` : undefined,
		];
		this.#activity.addChild(
			new TruncatedText(
				theme.fg("accent", `Agents: ${counts.filter(Boolean).join(", ")}`) + theme.fg("dim", " · /agents switch · /stop"),
				1,
				0,
			),
		);
		for (const item of activity.slice(0, 6)) {
			const icon =
				item.kind === "watcher"
					? theme.fg("muted", "◇")
					: item.kind === "swarm"
						? theme.fg("accent", "⬢")
						: theme.fg("warning", "●");
			const parts = [
				item.status,
				item.model,
				item.cost === undefined || item.cost === 0 ? undefined : `$${item.cost.toFixed(3)}`,
			].filter(Boolean);
			this.#activity.addChild(
				new TruncatedText(`  ${icon} ${item.label}${theme.fg("dim", ` · ${parts.join(" · ")}`)}`, 1, 0),
			);
		}
		if (activity.length > 6) {
			this.#activity.addChild(new TruncatedText(theme.fg("dim", `  … ${activity.length - 6} more`), 1, 0));
		}
	}

	#syncQueue(inbox: InboxState): void {
		this.#queue.clear();
		for (const item of inbox.items) {
			const text =
				item.mode === "write" ? `<${String(item.entry.kind)}>` : userText(item.content as UserMessage["content"]);
			this.#queue.addChild(new TruncatedText(theme.fg("muted", `[${item.mode}] ${text}`), 1, 0));
		}
	}

	#syncNotices(view: DurableView): void {
		this.#notices.clear();
		const notices = view.notices.filter((item) => item.id > this.#noticesClearedThrough);
		const errors = notices.filter((item) => item.level === "error").length;
		const warnings = notices.filter((item) => item.level === "warning").length;
		this.#noticeCounts =
			errors + warnings === 0
				? ""
				: [
						errors > 0 ? theme.fg("error", `✖ ${errors}`) : undefined,
						warnings > 0 ? theme.fg("warning", `⚠ ${warnings}`) : undefined,
						theme.fg("dim", this.#noticesShown ? "/notices hide" : "/notices"),
					]
						.filter(Boolean)
						.join(" ");
		// Info notices answer a command (/session, /reload), so they always show.
		const shown = this.#noticesShown ? notices : notices.filter((item) => item.level === "info");
		for (const item of shown.slice(-4)) {
			const color = item.level === "error" ? "error" : item.level === "warning" ? "warning" : "muted";
			this.#notices.addChild(new TruncatedText(theme.fg(color, item.message), 1, 0));
		}
	}

	#syncStatus(live: LiveState): void {
		const generation = live.generation;
		const compaction = live.compactions?.[0];
		const runningTool = live.tools?.find((slot) => slot.status === "running");
		let text = "";
		if (generation?.retry !== undefined) {
			text = `Retrying (attempt ${generation.attempt + 1}): ${generation.retry.error}`;
		} else if (generation?.deferred !== undefined) text = "Waiting for deferred response...";
		else if (compaction !== undefined) {
			text = compaction.retry
				? `Retrying ${compaction.trigger} compaction (attempt ${compaction.attempt + 1})...`
				: `Compacting (${compaction.trigger})...`;
		} else if (runningTool !== undefined) text = `Running ${runningTool.name}... (esc to abort)`;
		else if (live.run !== undefined) text = "Working... (esc to abort)";
		if (text === this.#statusText) return;
		this.#statusText = text;
		this.#indicator?.dispose();
		this.#indicator = text
			? new WorkingStatusIndicator(this.#ui, text, undefined, (part) => this.#editor.borderColor(part))
			: undefined;
		this.#editor.setWorkingStatusIndicator(this.#indicator);
	}

	#syncFooter(view: DurableView): void {
		const agent = agentOf(view.conversation);
		const usage = totalUsage((view.conversation.docs["pi.usage"] ?? { models: {}, tools: {} }) as UsageState);
		const stats: string[] = [];
		if (usage.input) stats.push(`↑${formatTokens(usage.input)}`);
		if (usage.output) stats.push(`↓${formatTokens(usage.output)}`);
		if (usage.cacheRead) stats.push(`R${formatTokens(usage.cacheRead)}`);
		if (usage.cacheWrite) stats.push(`W${formatTokens(usage.cacheWrite)}`);
		stats.push(`$${usage.cost.total.toFixed(3)}`);
		const contextWindow =
			view.models.find((model) => model.provider === agent.model?.provider && model.modelId === agent.model.modelId)
				?.contextWindow ?? 0;
		if (contextWindow > 0) {
			const tokens = contextTokens(view.conversation.entries);
			const percent = tokens === undefined ? undefined : (tokens / contextWindow) * 100;
			const text = `${percent === undefined ? "?" : percent.toFixed(1)}%/${formatTokens(contextWindow)}`;
			stats.push(percent !== undefined && percent > 90 ? theme.fg("error", text) : text);
		}
		const name = view.session.name === undefined ? "" : ` • ${view.session.name}`;
		const counts = this.#noticeCounts === "" ? "" : `${this.#noticeCounts}  `;
		this.#footerStats.setText(counts + theme.fg("dim", `${stats.join(" ")}  ${view.session.cwd}${name}`));
		const account = view.account === undefined ? "" : ` (${view.account})`;
		const model = agent.model === undefined ? "no model" : `${agent.model.provider}/${agent.model.modelId}${agent.model.provider === "anthropic" ? account : ""}`;
		const shown = view.conversations.find((candidate) => candidate.id === view.conversation.conversation.id);
		const label = shown?.label ?? `conversation ${view.conversation.conversation.id}`;
		this.#footerHints.setText(
			`${theme.fg(label === "main" ? "dim" : "accent", label)}${theme.fg(
				"dim",
				` · ${model} · thinking:${agent.thinkingLevel ?? "off"} (${keyText("app.thinking.cycle")}) · ${keyText("app.model.select")} model · /tree · /agents · /dashboard · ${keyText("app.message.followUp")} follow-up · ${keyText("app.clear")} exit`,
			)}`,
		);
	}

	#syncTranscript(entries: readonly EntryRecord[]): void {
		// Compaction and resets replace the head of the active transcript.
		if (this.#renderedEntryIds.some((id, index) => entries[index]?.id !== id)) this.#rebuild(entries);
		for (const entry of entries.slice(this.#renderedEntryIds.length)) {
			this.#addEntry(entry);
			this.#renderedEntryIds.push(entry.id);
		}
	}

	#rebuild(entries: readonly EntryRecord[]): void {
		this.#chat.clear();
		this.#discardTools();
		this.#summaries.length = 0;
		this.#rebuilt = true;
		this.#renderedEntryIds = [];
		this.#streaming = undefined;
		for (const entry of entries) {
			this.#addEntry(entry);
			this.#renderedEntryIds.push(entry.id);
		}
	}

	#addEntry(entry: EntryRecord): void {
		const message = entry.model?.[0];
		if ((entry.kind === REPORT_KIND || entry.kind === MESSAGE_KIND) && entry.data !== undefined) {
			const note = new NoteComponent(entry.kind, entry.data as NoteData, this.#expanded);
			this.#summaries.push(note);
			this.#chat.addChild(new Spacer(1));
			this.#chat.addChild(note);
		} else if (isInput(entry) && message?.role === "user") {
			this.#addInput(userText(message.content));
		} else if (entry.kind === "pi.assistant" && message?.role === "assistant") {
			const component = this.#streaming ?? new AssistantMessageComponent();
			if (this.#streaming === undefined) this.#chat.addChild(component);
			this.#streaming = undefined;
			component.updateContent(message, false);
			// Only a tool-calling answer runs its calls; an aborted, failed, or truncated one never does.
			const ran = message.stopReason === "toolUse";
			for (const content of message.content) {
				if (content.type !== "toolCall") continue;
				const streamed = this.#streamingCalls.has(content.id);
				// Only cards the stream already showed are kept for calls that never run.
				if (!ran && !streamed) continue;
				const card = this.#tool(content.name, content.id, content.arguments, !streamed);
				card.setArgsComplete();
				if (!ran) {
					const text = "Not run: the answer was interrupted.";
					card.updateResult({ content: [{ type: "text", text }], isError: true }, false);
				}
			}
			this.#streamingCalls.clear();
		} else if (entry.kind === "pi.tool-result" && message?.role === "toolResult") {
			const result = message as ToolResultMessage;
			this.#tool(result.toolName, result.toolCallId).updateResult(result);
		} else if (entry.kind === "pi.compaction") {
			const summary = new CompactionComponent(
				message?.role === "user" ? userText(message.content) : "",
				this.#expanded,
			);
			this.#summaries.push(summary);
			this.#chat.addChild(new Spacer(1));
			this.#chat.addChild(summary);
		} else if (entry.kind === "pi.reset") this.#addText("[new context]");
	}

	/** A user input; a skill invocation shows pi's collapsed skill card, then the request that came with it. */
	#addInput(input: string): void {
		this.#chat.addChild(new Spacer(1));
		const blocks = REFERENCE_BLOCKS.exec(input);
		const text = blocks === null ? input : input.slice(0, blocks.index);
		const skill = parseSkillBlock(text);
		if (skill === null) {
			this.#chat.addChild(new UserMessageComponent(text));
			if (blocks !== null) {
				const count = (blocks[1]!.match(/<reference to=/gu) ?? []).length;
				this.#addText(`[${count} reference${count === 1 ? "" : "s"} attached]`);
			}
			return;
		}
		const card = new SkillInvocationMessageComponent(skill, getMarkdownTheme());
		card.setExpanded(this.#expanded);
		this.#summaries.push(card);
		this.#chat.addChild(card);
		if (skill.userMessage) this.#chat.addChild(new UserMessageComponent(skill.userMessage));
	}

	#syncStreaming(message: AssistantMessage): void {
		if (this.#streaming === undefined) {
			this.#streaming = new AssistantMessageComponent();
			this.#chat.addChild(this.#streaming);
		}
		this.#streaming.updateContent(message, true);
		for (const content of message.content) {
			if (content.type !== "toolCall") continue;
			this.#tool(content.name, content.id, content.arguments, !this.#streamingCalls.has(content.id));
			this.#streamingCalls.add(content.id);
		}
	}

	#addText(text: string): void {
		this.#chat.addChild(new Spacer(1));
		this.#chat.addChild(new Text(theme.fg("muted", text), 1, 0));
	}

	/** The card of a call; `fresh` starts a new one for a call ID an earlier turn used. */
	#tool(name: string, callId: string, args?: unknown, fresh = false): ToolExecutionComponent {
		const existing = fresh ? undefined : this.#tools.get(callId);
		if (existing !== undefined) {
			if (args !== undefined) existing.updateArgs(args);
			return existing;
		}
		const component = new ToolExecutionComponent(
			name,
			callId,
			args ?? {},
			{},
			DurableTui.#renderers[name],
			this.#ui,
			this.#cwd,
		);
		component.setExpanded(this.#expanded);
		this.#chat.addChild(component);
		this.#cards.push(component);
		this.#tools.set(callId, component);
		return component;
	}
}

function describeTask(node: TaskGraphNode): string {
	const state = node.state;
	const status =
		state.status === "waiting"
			? `waiting on ${state.on.join(", ")}`
			: state.status === "completing"
				? `completing (${state.outcome})`
				: `${state.status} ${state.phase}`;
	const flags = [node.background ? "background" : "", node.abortRequested ? "aborting" : ""].filter(Boolean);
	const owned = node.conversations.length > 0 ? ` owns conversation ${node.conversations.join(", ")}` : "";
	return `${node.kind} #${node.id}: ${status}${flags.length > 0 ? ` [${flags.join(", ")}]` : ""}${owned}`;
}

function totalUsage(state: UsageState): Usage {
	const total: Usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	for (const usage of [...Object.values(state.models), ...Object.values(state.tools)]) {
		total.input += usage.input;
		total.output += usage.output;
		total.cacheRead += usage.cacheRead;
		total.cacheWrite += usage.cacheWrite;
		total.cost.total += usage.cost.total;
	}
	return total;
}

/** Context size from the newest successful answer after the newest compaction; unknown before one. */
function contextTokens(entries: readonly EntryRecord[]): number | undefined {
	// Kept entries follow the summary in the view but are older than it; only later answers measure the new context.
	const compacted = Math.max(0, ...entries.filter((entry) => entry.kind === "pi.compaction").map((entry) => entry.id));
	for (const entry of [...entries].reverse()) {
		const message = entry.model?.[0];
		if (entry.id < compacted || entry.kind !== "pi.assistant" || message?.role !== "assistant") continue;
		if (message.stopReason === "aborted" || message.stopReason === "error") continue;
		const usage = message.usage;
		return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	}
	return undefined;
}

function openElsewhere(row: DashboardRow): string {
	return `Open in another process (pid ${row.session.live?.pid ?? "?"}); refer to it with @session:${row.session.id.slice(0, 13)}, or message it with the sessions tool.`;
}

/**
 * The dashboard on its own (`pi-durable agents`): every session by project. Returns the session picked to open, or
 * undefined when the user leaves.
 */
export async function runDashboard(): Promise<SessionTarget | undefined> {
	const settings = SettingsManager.create(process.cwd(), getAgentDir());
	setCapabilityOverrides(settings.getTerminalCapabilityOverrides());
	initTheme();
	setKeybindings(KeybindingsManager.create());
	const ui = new TuiAltScreen(new ProcessTerminal(), false, getAgentDir());
	const themes = new InteractiveThemeController(ui, {
		getSettingsManager: () => settings,
		showError: (message) => console.error(message),
		onChanged: () => ui.requestRender(),
	});
	let finish = (_target: SessionTarget | undefined): void => {};
	const picked = new Promise<SessionTarget | undefined>((resolve) => {
		finish = resolve;
	});
	const dashboard: DashboardComponent = new DashboardComponent(
		undefined,
		(row) => {
			if (row.open) dashboard.notify(openElsewhere(row));
			else finish({ kind: "open", directory: row.session.path });
		},
		() => finish(undefined),
		() => ui.requestRender(),
	);
	ui.addChild(dashboard);
	ui.setFocus(dashboard);
	ui.start();
	themes.applyFromSettings();
	try {
		return await picked;
	} finally {
		dashboard.dispose();
		themes.dispose();
		ui.stop();
	}
}

/**
 * Run the TUI on an open session until the user quits, or picks another session with /new or /resume: then the
 * session to open next is returned, and the caller reopens with it.
 */
export async function runDurableTui(durable: OpenDurableResult): Promise<SessionTarget | undefined> {
	const { view: source, controller, resources, approvals } = durable;
	const settings = resources.settings;
	setCapabilityOverrides(settings.getTerminalCapabilityOverrides());
	// The system theme until the controller resolves the user's theme against the terminal's colors.
	initTheme();
	let next: SessionTarget | undefined;
	let exit = (): void => {};
	const exited = new Promise<void>((resolve) => {
		exit = resolve;
	});
	const leave = (target: SessionTarget): void => {
		next = target;
		exit();
	};
	let view!: DurableTui;
	const rows = (): number => view.ui.terminal.rows;

	const selectModel = (): void => {
		const snapshot = source.current();
		const current = agentOf(snapshot.conversation).model;
		const isCurrent = (model: { provider: string; modelId: string }) =>
			model.provider === current?.provider && model.modelId === current.modelId;
		const items: SelectItem[] = [...snapshot.models]
			.sort((left, right) => Number(isCurrent(right)) - Number(isCurrent(left)))
			.map((model) => ({
				value: `${model.provider}/${model.modelId}`,
				label: model.modelId,
				description: model.provider,
			}));
		const selector = new ListSelector(
			"Select model:",
			items,
			(value) => {
				view.restoreEditor();
				const separator = value.indexOf("/");
				void controller.setModel({ provider: value.slice(0, separator), modelId: value.slice(separator + 1) });
			},
			() => view.restoreEditor(),
		);
		view.mount(selector);
	};

	const selectThinking = (): void => {
		const items: SelectItem[] = THINKING_LEVELS.map((level) => ({ value: level, label: level }));
		view.mount(
			new ListSelector(
				"Thinking level:",
				items,
				(value) => {
					view.restoreEditor();
					void controller.setThinking(value as ModelThinkingLevel);
				},
				() => view.restoreEditor(),
			),
		);
	};

	const selectConversation = (): void => {
		const snapshot = source.current();
		const working = new Map(
			snapshot.activity.flatMap((item) => (item.conversationId === undefined ? [] : [[item.conversationId, item.status]])),
		);
		const items: SelectItem[] = [...snapshot.conversations].reverse().map((candidate) => {
			const traits = [
				candidate.id === snapshot.conversation.conversation.id ? "(shown)" : undefined,
				working.has(candidate.id) ? `[${working.get(candidate.id)}]` : undefined,
				candidate.profile !== undefined && candidate.profile !== "general" ? `<${candidate.profile}>` : undefined,
				candidate.background === true ? "<background>" : undefined,
				candidate.title,
			].filter(Boolean);
			return { value: String(candidate.id), label: candidate.label, description: traits.join(" ") };
		});
		const selector = new ListSelector(
			"Switch to:",
			items,
			(value) => {
				view.restoreEditor();
				void controller.switchConversation(Number(value) as ConversationId);
			},
			() => view.restoreEditor(),
		);
		view.mount(selector);
	};

	/** Continue from a node: a user message comes back into the editor, as in pi. */
	const navigate = async (nodeId: string): Promise<void> => {
		const text = await controller.navigate(nodeId);
		if (text !== undefined) view.editor.setText(text);
	};

	/** /tree, and /fork as the same tree filtered to user messages, both under an overview of the branches. */
	const showTree = async (mode: "tree" | "fork"): Promise<void> => {
		const session = await controller.tree();
		if (session.tree.length === 0) {
			return controller.notify("info", mode === "fork" ? "No messages to fork from" : "No entries in session");
		}
		const selector = branchTree(session, {
			...(mode === "fork"
				? {
						title: "Fork",
						hint: "Enter on a message starts a branch just before it and puts the message in the editor to edit and resend.",
						filter: "user-only" as const,
					}
				: {
						title: "Session Tree",
						hint: "Enter continues from a node: a branch's end switches to it, anything else forks there.",
					}),
			rows: rows(),
			onSelect: (nodeId) => {
				view.restoreEditor();
				if (nodeId === session.leafId) return controller.notify("info", "Already at this point");
				void navigate(nodeId);
			},
			onCancel: () => view.restoreEditor(),
			// pi's label editor in the tree; labels are kept in the session and found by @label: references.
			onLabelChange: (nodeId, label) => void controller.setLabel(nodeId, label),
		});
		view.mount(selector);
	};

	const showSwarmBoard = (): void => {
		const board: SwarmBoardComponent = new SwarmBoardComponent(
			() => controller.swarmBoard(),
			(id) => {
				board.dispose();
				view.restoreEditor();
				void controller.switchConversation(id);
			},
			() => {
				board.dispose();
				view.restoreEditor();
			},
			() => view.ui.requestRender(),
		);
		view.mount(board);
	};

	const swarmCommand = (args: string): void => {
		if (args === "" || args === "board") return showSwarmBoard();
		if (args === "end") return void controller.endSwarm();
		void controller.startSwarm(args);
	};

	const showStop = (): void => {
		const activity = source.current().activity.filter((item) => item.kind !== "swarm");
		if (activity.length === 0) return controller.notify("info", "Nothing is working besides this conversation");
		const items: SelectItem[] = activity.map((item) => ({
			value: item.key,
			label: item.label,
			description: item.kind === "watcher" ? `end watcher: ${item.status}` : `abort its current work: ${item.status}`,
		}));
		view.mount(
			new ListSelector(
				"Stop:",
				items,
				(value) => {
					view.restoreEditor();
					const item = activity.find((candidate) => candidate.key === value);
					if (item !== undefined) void controller.stop(item);
				},
				() => view.restoreEditor(),
			),
		);
	};

	const showProfiles = (): void => {
		const items: SelectItem[] = durable.profiles.all.map((profile) => {
			const traits = [
				profile.runner === "antigravity" ? `agy ${profile.model ?? "default"}` : profile.model,
				profile.tools === undefined || profile.runner === "antigravity" ? undefined : `tools: ${profile.tools.join(",")}`,
				profile.isolation === "worktree" ? "worktree" : undefined,
				profile.source === "built-in" ? "built-in" : profile.source,
			].filter(Boolean);
			return { value: profile.name, label: profile.name, description: `${profile.description} (${traits.join("; ")})` };
		});
		view.mount(
			new ListSelector(
				"Agent profiles (enter asks for a subagent with it):",
				items,
				(value) => {
					view.restoreEditor();
					view.editor.setText(`Use a ${value} subagent to `);
				},
				() => view.restoreEditor(),
			),
		);
	};

	const showDashboard = (): void => {
		const snapshot = source.current();
		const dashboard = new DashboardComponent(
			snapshot.session.directory,
			(row: DashboardRow) => {
				if (row.self) {
					view.restoreEditor();
					return controller.notify("info", "Already in this session");
				}
				if (row.open) return dashboard.notify(openElsewhere(row));
				view.restoreEditor();
				leave({ kind: "open", directory: row.session.path });
			},
			() => view.restoreEditor(),
			() => view.ui.requestRender(),
		);
		view.mount(dashboard);
	};

	const showBtw = (question: string): void => {
		const ref = agentOf(source.current().conversation).model;
		const model = ref === undefined ? "no model" : `${ref.provider}/${ref.modelId}`;
		const panel = new BtwComponent(question, model, () => view.restoreEditor(), () => view.ui.requestRender());
		view.mount(panel);
		void controller
			.btw(question, panel.signal, (progress) => panel.update(progress, model))
			.catch((error: unknown) =>
				panel.update({ text: "", done: true, error: error instanceof Error ? error.message : String(error) }, model),
			);
	};

	const showStatus = (): void => {
		view.mount(new StatusComponent(() => controller.status(), () => view.restoreEditor(), () => view.ui.requestRender()));
	};

	const showAccounts = (): void => {
		view.mount(
			new ReportPanel(
				{ title: "Accounts", loading: "Reading logins…", hint: ACCOUNTS_HINT },
				async () => accountsLines(await controller.accounts()),
				() => view.restoreEditor(),
				() => view.ui.requestRender(),
			),
		);
	};

	/**
	 * pi's login dialog in place of the editor; a method choice shows as a list over it, as in pi's /login.
	 * Both are layers, so an approval asked meanwhile shows over them and gives them back when answered.
	 */
	const signIn = (target: LoginTarget, providerId: string, providerName: string, title: string): void => {
		const dialog = new LoginDialogComponent(view.ui, providerId, () => {}, providerName, title);
		let closeList = (): void => {};
		const select = (prompt: { message: string; options: readonly { id: string; label: string; description?: string }[] }) =>
			new Promise<string>((resolve, reject) => {
				const items: SelectItem[] = prompt.options.map((option) => ({
					value: option.id,
					label: option.label,
					...(option.description === undefined ? {} : { description: option.description }),
				}));
				closeList = view.layer(
					new ListSelector(
						prompt.message,
						items,
						(value) => {
							closeList();
							resolve(value);
						},
						() => {
							closeList();
							reject(new Error("Login cancelled"));
						},
					),
				);
			});
		const closeDialog = view.layer(dialog);
		// Inside Rex the tab shows that pi-durable waits on the user, as for an approval.
		const release = view.waiting(title);
		void controller.login(target, dialogInteraction(dialog, select)).finally(() => {
			release();
			closeList();
			closeDialog();
		});
	};

	const accountsCommand = (args: string): void => {
		const command = parseAccountsCommand(args);
		switch (command.kind) {
			case "list":
				return showAccounts();
			case "usage":
				return controller.notify("info", command.message);
			case "add": {
				if (!validAccountName(command.name)) {
					return controller.notify("error", `Account names are lowercase letters, digits, - and _ (up to 32): ${command.name}`);
				}
				const title = `Sign Claude account "${command.name}" in`;
				return signIn({ kind: "account", name: command.name }, "anthropic", `Claude account "${command.name}"`, title);
			}
			case "login": {
				const providers = controller.loginProviders();
				// Exact ids only: signing in replaces the agent dir's login for that provider, so a typo must not pick one.
				const provider = providers.find((candidate) => candidate.id === command.provider);
				if (provider === undefined) {
					return controller.notify(
						"error",
						`No provider "${command.provider}" to sign in to (API keys: pi auth login <provider> --api-key). Providers: ${providers.map((candidate) => candidate.id).join(", ")}`,
					);
				}
				return signIn({ kind: "provider", id: provider.id }, provider.id, provider.name, `Login to ${provider.name}`);
			}
			case "remove": {
				const name = command.name;
				if (!controller.accountNames().includes(name)) {
					return controller.notify("error", `No extra Claude account "${name}"; /accounts lists them`);
				}
				return view.mount(
					new ListSelector(
						`Remove Claude account "${name}"? Its login (auth.json) is deleted.`,
						[
							{ value: "no", label: "Keep" },
							{ value: "yes", label: "Remove", description: `accounts/${name}/ is deleted; requests stop falling back to it` },
						],
						(value) => {
							view.restoreEditor();
							if (value === "yes") void controller.removeAccount(name);
						},
						() => view.restoreEditor(),
					),
				);
			}
		}
	};

	const showSessions = (): void => {
		const snapshot = source.current();
		const selector = new SessionSelectorComponent(
			() => listSessions(snapshot.session.cwd),
			() => listAllSessions(),
			(directory) => {
				view.restoreEditor();
				if (directory === snapshot.session.directory) return controller.notify("info", "Already in this session");
				leave({ kind: "open", directory });
			},
			() => view.restoreEditor(),
			exit,
			() => view.ui.requestRender(),
			{
				renameSession: async (directory, name) => {
					const trimmed = (name ?? "").trim();
					if (!trimmed) return;
					if (directory === snapshot.session.directory) await controller.rename(trimmed);
					else await writeMeta(directory, { name: trimmed });
				},
				showRenameHint: true,
				keybindings: KeybindingsManager.create(),
			},
			snapshot.session.directory,
		);
		view.mount(selector);
	};

	const showSession = (): void => {
		const snapshot = source.current();
		const shown = snapshot.conversations.find((c) => c.id === snapshot.conversation.conversation.id);
		const branches = snapshot.conversations.filter((c) => c.kind === "branch").length;
		const subagents = snapshot.conversations.filter((c) => c.kind === "subagent").length;
		controller.notify(
			"info",
			[
				`Session ${snapshot.session.name ?? snapshot.session.id}`,
				`showing ${shown?.label ?? snapshot.conversation.conversation.id}`,
				`${branches} branches, ${subagents} subagents`,
				`${resources.skills.length} skills, ${resources.prompts.length} prompts`,
				snapshot.session.directory,
			].join(" · "),
		);
		for (const problem of resources.diagnostics) controller.notify("warning", problem);
	};

	const copyLast = async (): Promise<void> => {
		const text = lastAnswer(source.current().conversation);
		if (text === undefined) return controller.notify("info", "No answer to copy yet");
		await copyToClipboard(text);
		controller.notify("info", "Copied the last answer.");
	};

	const modelItems = (): SelectItem[] =>
		source.current().models.map((model) => ({
			value: `${model.provider}/${model.modelId}`,
			label: model.modelId,
			description: model.provider,
		}));
	// pi's built-in commands this TUI handles, then prompt templates and skills; any other /text goes to the model.
	const builtins: SlashCommand[] = [
		{
			name: "model",
			description: "Select model (opens selector UI)",
			argumentHint: "<provider/model>",
			getArgumentCompletions: (prefix) => {
				const items = modelItems();
				return prefix ? fuzzyFilter(items, prefix, (item) => item.value) : items;
			},
		},
		{
			name: "thinking",
			description: "Set thinking level",
			argumentHint: "<level>",
			getArgumentCompletions: (prefix) =>
				THINKING_LEVELS.filter((level) => level.startsWith(prefix)).map((level) => ({ value: level, label: level })),
		},
		{ name: "tree", description: "Navigate the session tree (switch branches)" },
		{ name: "fork", description: "Branch from a previous user message (the tree, user messages only)" },
		{ name: "clone", description: "Branch the current conversation at its current position" },
		{ name: "agents", description: "Switch to the main conversation, a branch, or a subagent's" },
		{ name: "stop", description: "Stop a working subagent or a watcher" },
		{ name: "profiles", description: "List agent profiles for subagents" },
		{ name: "dashboard", description: "All sessions and their agents, by project" },
		{
			name: "btw",
			description: "Ask a quick side question about this conversation without steering it (no tools, not kept)",
			argumentHint: "<question>",
		},
		{ name: "status", description: "Subscription limits, today's usage across sessions, session counts" },
		{
			name: "accounts",
			description: "Logins by provider; add or remove Claude fallback accounts, sign in to a provider",
			argumentHint: "[add <name> | login <provider> | remove <name>]",
			getArgumentCompletions: (prefix) =>
				accountsCompletions(prefix, {
					accounts: () => controller.accountNames(),
					providers: () => controller.loginProviders(),
				}),
		},
		{
			name: "swarm",
			description: "Run a task as a swarm: this conversation coordinates workers on a shared board (quota heavy)",
			argumentHint: "<task> | board | end",
			getArgumentCompletions: (prefix) =>
				[
					{ value: "board", label: "board", description: "Show the swarm's board" },
					{ value: "end", label: "end", description: "Stop the running swarm" },
				].filter((item) => item.value.startsWith(prefix)),
		},
		{
			name: "research",
			description: "Deep research: researcher subagents, a critic, and a cited report in ~/research (the research skill)",
			argumentHint: "[--quick|--deep] <question>",
			getArgumentCompletions: (prefix) =>
				[
					{ value: "--quick", label: "--quick", description: "One round, no critic" },
					{ value: "--deep", label: "--deep", description: "Double budgets, up to three rounds" },
				].filter((item) => item.value.startsWith(prefix)),
		},
		{ name: "label", description: "Label the newest entry (refer to it with @label:<text>)", argumentHint: "<text>" },
		{ name: "tasks", description: "Show or hide the live task graph" },
		{
			name: "notices",
			description: "Show or hide warnings and errors (otherwise counted in the footer); clear dismisses them",
			argumentHint: "[clear]",
		},
		{ name: "compact", description: "Manually compact the session context", argumentHint: "[instructions]" },
		{ name: "new", description: "Start a new session" },
		{ name: "resume", description: "Resume another session" },
		{ name: "name", description: "Set session display name", argumentHint: "<name>" },
		{ name: "session", description: "Show session info" },
		{ name: "copy", description: "Copy last agent message to clipboard" },
		{ name: "reload", description: "Reload settings, skills, prompts, and context files" },
		{ name: "trust", description: "Trust this project and load its skills and prompts" },
		{ name: "quit", description: "Quit pi-durable" },
	];
	const commands = (): SlashCommand[] => [
		...builtins,
		...resources.prompts.map((template) => ({
			name: template.name,
			description: template.description,
			...(template.argumentHint === undefined ? {} : { argumentHint: template.argumentHint }),
		})),
		...(settings.getEnableSkillCommands()
			? resources.skills.map((skill) => ({ name: `skill:${skill.name}`, description: skill.description }))
			: []),
	];

	const dispatch = (text: string): void => {
		const space = text.indexOf(" ");
		const name = text.startsWith("/") ? (space === -1 ? text.slice(1) : text.slice(1, space)) : "";
		const args = space === -1 ? "" : text.slice(space + 1).trim();
		switch (name) {
			case "model": {
				const separator = args.indexOf("/");
				if (separator <= 0) return selectModel();
				return void controller.setModel({ provider: args.slice(0, separator), modelId: args.slice(separator + 1) });
			}
			case "thinking":
				if (THINKING_LEVELS.includes(args as ModelThinkingLevel)) {
					return void controller.setThinking(args as ModelThinkingLevel);
				}
				return selectThinking();
			case "tree":
				return void showTree("tree");
			case "fork":
				return void showTree("fork");
			case "clone":
				return void controller.clone();
			case "agents":
				return selectConversation();
			case "stop":
				return showStop();
			case "profiles":
				return showProfiles();
			case "dashboard":
				return showDashboard();
			case "btw":
				if (!args) return controller.notify("info", "Usage: /btw <question>");
				return showBtw(args);
			case "status":
				return showStatus();
			case "accounts":
				return accountsCommand(args);
			case "swarm":
				return swarmCommand(args);
			case "research":
				if (!args) return controller.notify("info", "Usage: /research [--quick|--deep] <question>");
				if (!resources.skills.some((skill) => skill.name === "research")) {
					return controller.notify("error", "The research skill is not loaded (pi/agent/skills/research); /reload after installing it");
				}
				return void controller.submit(`/skill:research ${args}`, "steer");
			case "label":
				if (!args) return controller.notify("info", "Usage: /label <text>; /tree edits any entry's label");
				return void controller.labelLatest(args);
			case "tasks":
				return void controller.toggleTasks();
			case "notices":
				return view.notices(args === "clear" ? "clear" : "toggle");
			case "compact":
				return void controller.compact(args || undefined);
			case "new":
				return leave({ kind: "new" });
			case "resume":
				return showSessions();
			case "name":
				if (!args) return controller.notify("info", "Usage: /name <name>");
				return void controller.rename(args);
			case "session":
				return showSession();
			case "copy":
				return void copyLast().catch((error) => controller.notify("error", String(error)));
			case "reload":
				return void controller.reload().then(() => view.setCommands(commands(), references));
			case "trust":
				return void controller.trust().then(() => view.setCommands(commands(), references));
			case "quit":
				return exit();
		}
		void controller.submit(text, "steer");
	};

	const references: ReferenceSources = {
		sessionId: () => source.current().session.id,
		conversations: () => source.current().conversations,
		labels: () => controller.labels(),
	};
	view = new DurableTui(source.current().session.cwd, {
		submit: (text) => {
			const trimmed = text.trim();
			if (trimmed) dispatch(trimmed);
		},
		followUp: (text) => void controller.submit(text, "followUp"),
		abort: () => void controller.abort(),
		exit,
		selectModel,
		cycleThinking: () => void controller.cycleThinking(),
	});
	view.setCommands(commands(), references);

	// Tools that must ask the user (antigravity's allowWrites) get a yes/no list in place of the editor.
	const unhandle = approvals.handle(
		(request, signal) =>
			new Promise<boolean>((resolve) => {
				let settled = false;
				let close = (): void => {};
				const release = view.waiting(request.title);
				const settle = (answer: boolean): void => {
					if (settled) return;
					settled = true;
					signal?.removeEventListener("abort", onAbort);
					release();
					close();
					resolve(answer);
				};
				const onAbort = (): void => settle(false);
				signal?.addEventListener("abort", onAbort, { once: true });
				// A layer, so a login dialog under it comes back once this is answered.
				close = view.layer(
					new ListSelector(
						request.title,
						[
							{ value: "yes", label: "Allow", description: request.message },
							{ value: "no", label: "Deny" },
						],
						(value) => settle(value === "yes"),
						() => settle(false),
					),
				);
			}),
	);

	// pi's theme handling: the theme setting (also light/dark pairs) resolved against the terminal's reported colors.
	const themes = new InteractiveThemeController(view.ui, {
		getSettingsManager: () => settings,
		showError: (message) => console.error(message),
		onChanged: () => view.ui.requestRender(),
	});
	const unsubscribe = source.subscribe(() => view.apply(source.current()));
	view.start();
	themes.applyFromSettings();
	view.apply(source.current());
	await exited;
	unhandle();
	unsubscribe();
	themes.dispose();
	view.stop();
	return next;
}

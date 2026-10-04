// The only module that touches OmO engine internals. Everything the public
// extension API cannot reach goes through the hooks below, so an omo bump has
// one place to check. Each hook degrades to stock rendering (with one debug-log
// line) when the internal it needs is missing, and never throws into omo.
//
// Internals touched (omo 5.1.13):
//   @code-yeongyu/senpi
//     InteractiveMode.prototype: setExtensionWidget (instance capture + widgets),
//       showExtensionNotify, handleHotkeysCommand, handleSessionCommand,
//       handleChangelogCommand, showError, showWarning, showNoticeBox,
//       addCacheMissNotice, addCompactionCostNotice, addContinuityNotice,
//       maybeShowAssistantDiagnostics, renderProjectTrustWarningIfNeeded,
//       showLoadedResources (+ instance field loadedResourcesContainer)
//     InteractiveMode instance fields: ui, editor, askUserQuestion,
//       editorContainer (addChild/clear/detachAll/removeChild/detachChild/render/children),
//       chatContainer (addChild, invalidate)
//     ToolExecutionComponent.prototype.render (+ fields identity, args, result,
//       isPartial, executionStarted, argsComplete, expanded, presentation)
//     AssistantMessageComponent.prototype.createRenderChild (descriptor.kind
//       "thinking-md" | "thinking-label" | "error-text")
//     UserMessageComponent, BashExecutionComponent (status, contentContainer),
//       CompactionSummaryMessageComponent, BranchSummaryMessageComponent,
//       SkillInvocationMessageComponent, CustomMessageComponent, CustomEntryComponent
//       (customEntry): prototype.render
//   @earendil-works/pi-tui
//     Box, Spacer (instanceof checks)
//     TUI instance: compositeOverlays, showOverlay, overlayStack, isOverlayVisible,
//       layoutRoot, setLayoutRoot, terminal, invalidate, requestRender
//     Markdown.prototype: renderToken (width capture), renderCodeBlock, highlightCodeBlock, theme
import * as senpi from "@code-yeongyu/senpi";
import * as tuiLib from "@earendil-works/pi-tui";
import type { Component, Theme } from "./style.ts";

type Method = (this: any, ...args: any[]) => any;
type AnyRecord = Record<string | symbol, any>;

const PREFIX = "omo-ui-chrome";
const ORIGINAL = (name: string) => Symbol.for(`${PREFIX}.original.${name}`);
const OWN = Symbol.for(`${PREFIX}.own`);
// Other extensions can set this on a component they put in the editor's place
// to keep it inline instead of being drawn as a modal.
export const INLINE = Symbol.for(`${PREFIX}.inline`);

const logged = new Set<string>();
function debug(key: string, detail: string): void {
	if (logged.has(key)) return;
	logged.add(key);
	try {
		process.stderr.write(`[ui-chrome] ${key}: ${detail}; stock rendering kept\n`);
	} catch {}
}

function guard<T>(key: string, run: () => T, fallback: () => T): T {
	try {
		return run();
	} catch (error) {
		debug(key, error instanceof Error ? error.message : String(error));
		return fallback();
	}
}

// Wraps target[name]. omo's own method stays on the target under a global
// symbol, so /reload's fresh copy of this module re-wraps the original rather
// than stacking a wrapper on the previous copy's. That re-wrap can drop a hook
// another extension stacked on top (ui-prompt's editorContainer.addChild), so
// ui-prompt re-checks its hook before each question.
function patch(target: unknown, name: string, wrap: (original: Method) => Method): boolean {
	const slots = target as AnyRecord | undefined;
	if (!slots) {
		debug(name, "patch target missing");
		return false;
	}
	const key = ORIGINAL(name);
	const original = (Object.hasOwn(slots, key) ? slots[key] : undefined) ?? slots[name];
	if (typeof original !== "function") {
		debug(name, "method missing");
		return false;
	}
	slots[key] = original;
	slots[name] = wrap(original);
	return true;
}

// Shadows obj[name] for one call. An instance patch already there (another
// hook's) is restored afterwards instead of being deleted.
function shadow<R>(obj: AnyRecord, name: string, replacement: Method, run: () => R): R {
	const had = Object.hasOwn(obj, name);
	const previous = obj[name];
	obj[name] = replacement;
	const restore = () => {
		if (had) obj[name] = previous;
		else delete obj[name];
	};
	let result: R;
	try {
		result = run();
	} catch (error) {
		restore();
		throw error;
	}
	if (result instanceof Promise) return result.finally(restore) as R;
	restore();
	return result;
}

const proto = (cls: unknown): AnyRecord | undefined => (typeof cls === "function" ? (cls as { prototype: AnyRecord }).prototype : undefined);
const S = senpi as unknown as Record<string, unknown>;
const T = tuiLib as unknown as Record<string, unknown>;
const MODE = proto(S.InteractiveMode);

export type HostTui = {
	terminal: { columns: number; rows: number };
	requestRender(force?: boolean): void;
	showOverlay(component: Component, options?: Record<string, unknown>): OverlayHandle;
	hideOverlay(): void;
	overlayStack?: { component: Component; options?: { nonCapturing?: boolean } }[];
	isOverlayVisible?(entry: unknown): boolean;
	layoutRoot?: Component;
	invalidate(): void;
};
export type OverlayHandle = { hide(): void };

type Mode = AnyRecord & {
	ui: HostTui;
	editor: Component;
	askUserQuestion?: Component;
	editorContainer: AnyRecord & { children: Component[] };
	chatContainer: AnyRecord;
};

let mode: Mode | undefined;
let getTheme: (() => Theme) | undefined;
const readyHooks: ((tui: HostTui) => void)[] = [];

// A context from before /reload throws on access ("stale extension
// generation"); until the new copy's session_start, that reads as no theme.
export function theme(): Theme | undefined {
	try {
		return getTheme?.();
	} catch {
		return undefined;
	}
}

export function tui(): HostTui | undefined {
	return mode?.ui;
}

export function requestRender(): void {
	mode?.ui.requestRender();
}

export function onReady(hook: (tui: HostTui) => void): void {
	readyHooks.push(hook);
}

type Pi = { on(event: string, handler: (event: unknown, ctx: any) => unknown): void };

// The extension API hands extensions no InteractiveMode. ctx.ui.setWidget
// calls InteractiveMode.setExtensionWidget on it, so a wrapped prototype
// method sees the instance when we set (and clear) a throwaway widget.
// Headless runs have no UI, and on a shared RPC host ctx.ui forwards to
// another process, so the wrapper never fires there and nothing is installed.
export function connect(pi: Pi): void {
	readyHooks.length = 0;
	installWidgetPatch();
	// /reload, /new and session switches end this copy's session first; its
	// wrappers stay installed until the next copy re-wraps, so they must see
	// no host and draw stock in between.
	pi.on("session_shutdown", () => {
		mode = undefined;
		getTheme = undefined;
	});
	pi.on("session_start", (_event, ctx) => {
		if (!ctx?.hasUI || !MODE) return;
		getTheme = () => ctx.ui.theme as Theme;
		captured = undefined;
		ctx.ui.setWidget(`${PREFIX}.capture`, undefined);
		const found = captured as Mode | undefined;
		if (!found || !isRealTui(found.ui)) return;
		mode = found;
		for (const hook of readyHooks) guard("ready", () => hook(found.ui), () => undefined);
		// Rows rendered before this copy loaded are cached by revision.
		guard("invalidate", () => found.ui.invalidate(), () => undefined);
		found.ui.requestRender();
	});
}

function isRealTui(ui: unknown): ui is HostTui {
	try {
		const t = ui as HostTui;
		return Array.isArray(t.overlayStack) && typeof t.showOverlay === "function" && typeof t.terminal?.columns === "number";
	} catch {
		return false;
	}
}

let captured: unknown;
export type WidgetContent = string[] | ((tui: unknown, theme: Theme) => Component);
type WidgetHook = (key: string, content: WidgetContent) => WidgetContent;
let widgetHook: WidgetHook | undefined;

export function onWidget(hook: WidgetHook): void {
	widgetHook = hook;
}

function installWidgetPatch(): void {
	patch(MODE, "setExtensionWidget", (original) =>
		function (this: unknown, key: string, content: WidgetContent | undefined, options: unknown) {
			captured = this;
			const next = content === undefined || !widgetHook ? content : guard("widget", () => widgetHook!(key, content), () => content);
			return original.call(this, key, next, options);
		},
	);
}

export function own<C extends object>(component: C): C {
	return Object.assign(component, { [OWN]: true });
}

// A centred overlay sized from the live terminal. Getters keep it fitted
// across resizes because omo re-reads the options object every frame.
export function modalOptions(width: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		anchor: "center",
		margin: { top: 1, bottom: 1, left: 2, right: 2 },
		get width() {
			return Math.min(width, Math.max(20, (mode?.ui.terminal.columns ?? width) - 4));
		},
		...extra,
	};
}

export function showModal(component: Component, width: number): OverlayHandle | undefined {
	const ui = mode?.ui;
	if (!ui) return undefined;
	return ui.showOverlay(own(component), modalOptions(width));
}

export function modalOpen(): boolean {
	const ui = mode?.ui;
	if (!ui?.overlayStack) return false;
	return ui.overlayStack.some(
		(entry) => (ui.isOverlayVisible?.(entry) ?? true) && (!entry.options?.nonCapturing || (entry.component as AnyRecord)[MODAL] === true),
	);
}

const MODAL = Symbol.for(`${PREFIX}.modal`);

export function onFrame(rewrite: (screen: string[], width: number, height: number) => string[]): void {
	onReady((ui) =>
		patch(ui, "compositeOverlays", (original) =>
			function (this: HostTui, lines: string[], width: number, height: number) {
				if (!this.layoutRoot) return original.call(this, lines, width, height);
				const screen = guard("frame", () => rewrite(lines, width, height), () => lines);
				return original.call(this, screen, width, height);
			},
		),
	);
}

// Every screen omo puts in the editor's place goes through
// editorContainer.clear(); addChild(screen); setFocus(screen), and leaves with
// clear(); addChild(editor). The screen stays in the container, so omo's
// dispose, focus and mount checks are unchanged; while it is claimed the
// container draws the prompt in its place and the hook's modal draws the
// screen in a non-capturing overlay. Focus stays on omo's component, so it
// keeps every key.
export type Screen = { name: string; stock: Component };
type ScreenHook = (screen: Screen) => { component: Component; width: number } | undefined;
let screenHook: ScreenHook | undefined;
const SKIPPED_SCREENS = new Set(["AskUserQuestionComponent"]);

export function onEditorScreen(hook: ScreenHook): void {
	screenHook = hook;
	onReady(() => patchEditorContainer());
}

function patchEditorContainer(): void {
	const host = mode;
	const box = host?.editorContainer;
	if (!host || !box) return debug("editorContainer", "missing");
	const open = new Map<Component, OverlayHandle>();
	const sync = () => {
		for (const [stock, handle] of open) {
			if (!box.children.includes(stock)) {
				open.delete(stock);
				handle.hide();
			}
		}
	};
	patch(box, "addChild", (original) =>
		function (this: unknown, component: Component) {
			const result = original.call(this, component);
			guard(
				"editorScreen",
				() => {
					if (!component || component === host.editor || component === host.askUserQuestion || open.has(component)) return;
					const name = (component as AnyRecord).constructor?.name ?? "";
					if (SKIPPED_SCREENS.has(name) || (component as AnyRecord)[INLINE]) return;
					const shown = screenHook?.({ name, stock: component });
					if (!shown) return;
					const modal = Object.assign(shown.component, { [MODAL]: true });
					open.set(component, host.ui.showOverlay(own(modal), modalOptions(shown.width, { nonCapturing: true })));
				},
				() => undefined,
			);
			return result;
		},
	);
	for (const name of ["clear", "detachAll", "removeChild", "detachChild"]) {
		patch(box, name, (original) =>
			function (this: unknown, ...args: unknown[]) {
				const result = original.apply(this, args);
				guard("editorScreen.close", sync, () => undefined);
				return result;
			},
		);
	}
	patch(box, "render", (original) =>
		function (this: { children: Component[] }, width: number) {
			if (open.size === 0) return original.call(this, width);
			const children = this.children;
			this.children = children.map((child) => (open.has(child) ? host.editor : child));
			try {
				return original.call(this, width);
			} finally {
				this.children = children;
			}
		},
	);
}

// Stock overlays (ctx.ui.custom with overlay: true, e.g. /help, /history).
// The hook may return a modal drawn in the stock component's place; the
// overlay entry is the same, so omo's hideOverlay still closes it.
type OverlayHook = (screen: Screen) => { component: Component; width: number } | undefined;
let overlayHook: OverlayHook | undefined;

export function onStockOverlay(hook: OverlayHook): void {
	overlayHook = hook;
	onReady((ui) =>
		patch(ui, "showOverlay", (original) =>
			function (this: HostTui, component: Component, options?: Record<string, unknown>) {
				const swap = guard(
					"stockOverlay",
					() => {
						if (!component || (component as AnyRecord)[OWN] || options?.nonCapturing) return undefined;
						const name = (component as AnyRecord).constructor?.name ?? "";
						return overlayHook?.({ name, stock: component });
					},
					() => undefined,
				);
				if (!swap) return original.call(this, component, options);
				return original.call(this, own(swap.component), modalOptions(swap.width));
			},
		),
	);
}

type NotifyHook = (message: string, type: string | undefined) => boolean;

// ctx.ui.notify reaches InteractiveMode.showExtensionNotify; a hook returning
// true takes the message instead of the transcript status line.
export function onNotify(hook: NotifyHook): void {
	patch(MODE, "showExtensionNotify", (original) =>
		function (this: unknown, message: string, type?: string) {
			const taken = guard("notify", () => hook(message, type), () => false);
			if (!taken) return original.call(this, message, type);
		},
	);
}

// /hotkeys, /session and /changelog append their text to the transcript. The
// components appended during the command go to the hook, which may take them.
export type TranscriptPanel = "hotkeys" | "session" | "changelog";
const PANEL_METHODS: Record<TranscriptPanel, string> = {
	hotkeys: "handleHotkeysCommand",
	session: "handleSessionCommand",
	changelog: "handleChangelogCommand",
};

export function onTranscriptPanel(hook: (panel: TranscriptPanel, parts: Component[]) => boolean): void {
	for (const [panel, name] of Object.entries(PANEL_METHODS) as [TranscriptPanel, string][]) {
		patch(MODE, name, (original) =>
			function (this: Mode, ...args: unknown[]) {
				const chat = this.chatContainer;
				const held: Component[] = [];
				const finish = () => {
					if (held.length === 0) return;
					if (!guard("transcriptPanel", () => hook(panel, held), () => false)) for (const c of held) chat.addChild(c);
				};
				const result = shadow(chat, "addChild", (component: Component) => void held.push(component), () => original.apply(this, args));
				if (result instanceof Promise) return result.finally(finish);
				finish();
				return result;
			},
		);
	}
}

export type NoticeTone = "error" | "warning" | "muted";
const NOTICE_METHODS: Record<string, NoticeTone> = {
	showError: "error",
	showWarning: "warning",
	showNoticeBox: "warning",
	addCacheMissNotice: "warning",
	addCompactionCostNotice: "warning",
	addContinuityNotice: "muted",
	maybeShowAssistantDiagnostics: "warning",
	renderProjectTrustWarningIfNeeded: "warning",
};
const SPACER = T.Spacer as (new (...args: unknown[]) => Component) | undefined;

// Inline notices omo appends to the transcript from InteractiveMode methods.
// While one runs, each non-spacer component it appends goes through the hook,
// which returns what is appended instead. showNoticeBox carries its tone in
// the spec, so error boxes keep the error tone.
export function onTranscriptNotice(hook: (tone: NoticeTone, component: Component) => Component): void {
	for (const [name, defaultTone] of Object.entries(NOTICE_METHODS)) {
		patch(MODE, name, (original) =>
			function (this: Mode, ...args: unknown[]) {
				const chat = this.chatContainer;
				const tone = name === "showNoticeBox" && (args[0] as { tone?: string })?.tone === "error" ? "error" : defaultTone;
				const add = chat.addChild;
				const take = function (this: unknown, component: Component) {
					const isSpacer = SPACER !== undefined && component instanceof SPACER;
					const next = isSpacer ? component : guard("notice", () => hook(tone, component), () => component);
					return add.call(this, next);
				};
				return shadow(chat, "addChild", take, () => original.apply(this, args));
			},
		);
	}
	// Startup diagnostics (extension, skill and prompt conflicts) are notice
	// boxes appended next to the [Skills]/[Extensions] lists; only the boxes
	// are handed over, the lists stay as they are.
	const BOX = T.Box as (new (...args: unknown[]) => Component) | undefined;
	patch(MODE, "showLoadedResources", (original) =>
		function (this: Mode, ...args: unknown[]) {
			const box = this.loadedResourcesContainer as AnyRecord | undefined;
			if (!box || !BOX) return original.apply(this, args);
			const add = box.addChild;
			const take = function (this: unknown, component: Component) {
				const next = component instanceof BOX ? guard("notice", () => hook("warning", component), () => component) : component;
				return add.call(this, next);
			};
			return shadow(box, "addChild", take, () => original.apply(this, args));
		},
	);
}

export type ToolRow = {
	toolName: string;
	toolCallId: string;
	cwd: string;
	args: Record<string, unknown>;
	result?: { content?: { type: string; text?: string }[]; details?: unknown; isError?: boolean };
	isPartial: boolean;
	executionStarted: boolean;
	argsComplete: boolean;
	expanded: boolean;
};
type RowHook = (row: ToolRow, stock: (width: number) => string[], width: number) => string[];

// Every tool row (built-in, MCP, plugins) is a ToolExecutionComponent; there
// is no public way to restyle another extension's tool renderer, so the shared
// render is wrapped. Rows OmO folds into exploration groups are drawn by the
// group, so grouping is untouched.
export function onToolRow(hook: RowHook): void {
	patch(proto(S.ToolExecutionComponent), "render", (original) =>
		function (this: AnyRecord, width: number) {
			const stock = (w: number): string[] => original.call(this, w);
			if (this.presentation === "grok" || !mode) return stock(width);
			const identity = this.identity ?? {};
			const row: ToolRow = {
				toolName: identity.toolName,
				toolCallId: identity.toolCallId,
				cwd: identity.cwd,
				args: this.args ?? {},
				result: this.result,
				isPartial: this.isPartial,
				executionStarted: this.executionStarted,
				argsComplete: this.argsComplete,
				expanded: this.expanded,
			};
			return guard("toolRow", () => hook(row, stock, width), () => stock(width));
		},
	);
}

export type EntryKind = "user" | "bash" | "compaction" | "branch" | "skill" | "custom-message" | "custom-entry";
// `content` draws a `!cmd` run without omo's border rules.
export type Entry = { kind: EntryKind; status?: string; customType?: string; content?: (width: number) => string[] };
type EntryHook = (entry: Entry, stock: (width: number) => string[], width: number) => string[];

export function onTranscriptEntry(hook: EntryHook): void {
	const route = (cls: unknown, name: string, describe: (self: AnyRecord) => Entry) =>
		patch(proto(cls), "render", (original) =>
			function (this: AnyRecord, width: number) {
				const stock = (w: number): string[] => original.call(this, w);
				if (!mode) return stock(width);
				return guard(name, () => hook(describe(this), stock, width), () => stock(width));
			},
		);
	route(S.UserMessageComponent, "UserMessageComponent", () => ({ kind: "user" }));
	route(S.BashExecutionComponent, "BashExecutionComponent", (self) => ({ kind: "bash", status: self.status, content: (w) => bashContent(self, w) ?? [] }));
	route(S.CompactionSummaryMessageComponent, "CompactionSummaryMessageComponent", () => ({ kind: "compaction" }));
	route(S.BranchSummaryMessageComponent, "BranchSummaryMessageComponent", () => ({ kind: "branch" }));
	route(S.SkillInvocationMessageComponent, "SkillInvocationMessageComponent", () => ({ kind: "skill" }));
	route(S.CustomMessageComponent, "CustomMessageComponent", (self) => ({ kind: "custom-message", customType: self.message?.customType }));
	watchCustomEntries(hook);
}

function bashContent(self: unknown, width: number): string[] | undefined {
	const content = (self as AnyRecord)?.contentContainer;
	return typeof content?.render === "function" ? content.render(width) : undefined;
}

// Thinking blocks and turn errors are children AssistantMessageComponent
// builds per message part; the child's render is replaced in place so omo's
// click-to-toggle stays attached.
export type AssistantPart = "thinking-label" | "thinking-md" | "error-text";
const PARTS = new Set<string>(["thinking-label", "thinking-md", "error-text"]);

export function onAssistantPart(hook: (part: AssistantPart, stock: (width: number) => string[], width: number) => string[]): void {
	patch(proto(S.AssistantMessageComponent), "createRenderChild", (original) =>
		function (this: unknown, descriptor: { kind: string }) {
			const child: Component = original.call(this, descriptor);
			if (!child || !PARTS.has(descriptor?.kind)) return child;
			const render = child.render.bind(child);
			child.render = (width: number) => guard("assistantPart", () => hook(descriptor.kind as AssistantPart, render, width), () => render(width));
			return child;
		},
	);
}

// Markdown.renderCodeBlock(lines, code, lang, indent) pushes a ``` fence, the
// highlighted lines and a closing fence without knowing the width, so
// renderToken (its caller) records the width it was given.
export type CodeBlock = { code: string; lang: string | undefined; width: number; highlight(): string[] };
const TOKEN_WIDTH = Symbol.for(`${PREFIX}.markdown.width`);

export function onCodeBlock(hook: (block: CodeBlock) => string[] | undefined): void {
	const markdown = proto(T.Markdown);
	patch(markdown, "renderToken", (original) =>
		function (this: AnyRecord, token: unknown, width: number, ...rest: unknown[]) {
			const outer = this[TOKEN_WIDTH];
			this[TOKEN_WIDTH] = width;
			try {
				return original.call(this, token, width, ...rest);
			} finally {
				this[TOKEN_WIDTH] = outer;
			}
		},
	);
	patch(markdown, "renderCodeBlock", (original) =>
		function (this: AnyRecord, lines: string[], code: string, lang: string | undefined, indent: string) {
			const width = this[TOKEN_WIDTH] as number | undefined;
			const highlight = (): string[] =>
				this.highlightCodeBlock?.(code, lang) ?? code.split("\n").map((line) => (this.theme?.codeBlock ? this.theme.codeBlock(line) : line));
			const drawn = width === undefined || !mode ? undefined : guard("codeBlock", () => hook({ code, lang, width, highlight }), () => undefined);
			if (drawn) lines.push(...drawn);
			else original.call(this, lines, code, lang, indent);
		},
	);
}

// CustomEntryComponent is not exported. omo builds one in
// addCustomEntryToChat and splices it into the transcript, so its class is
// taken from the transcript after that method runs (or from a restored one).
let customEntryClass: unknown;

function watchCustomEntries(hook: EntryHook): void {
	const install = (cls: unknown) => {
		if (!cls || customEntryClass) return;
		customEntryClass = cls;
		patch(proto(cls), "render", (original) =>
			function (this: AnyRecord, width: number) {
				const stock = (w: number): string[] => original.call(this, w);
				if (!mode) return stock(width);
				const entry: Entry = { kind: "custom-entry", customType: this.customEntry?.customType };
				return guard("CustomEntryComponent", () => hook(entry, stock, width), () => stock(width));
			},
		);
	};
	const scan = (host: Mode | undefined) =>
		install((host?.chatContainer?.children as AnyRecord[] | undefined)?.find((c) => c?.constructor?.name === "CustomEntryComponent")?.constructor);
	customEntryClass = undefined;
	onReady(() => scan(mode));
	patch(MODE, "addCustomEntryToChat", (original) =>
		function (this: Mode, ...args: unknown[]) {
			const result = original.apply(this, args);
			if (!customEntryClass) guard("customEntryScan", () => scan(this), () => undefined);
			return result;
		},
	);
}

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, Container, TUI } from "@earendil-works/pi-tui";
import { PromptEditor, type PromptHost } from "./editor";
import { enableBarCursor, findParentContainer, hookAddChild, restoreCursor } from "./host";
import { isQuestionComponent, QuestionCard, questionHeader, questionRequestId } from "./question";
import { createState, DEFAULT_AGENT } from "./state";
import { applyTitle, restoreTitle } from "./title";
import { registerTurnFooter } from "./turn-footer";
import { installWorkingIndicator } from "./working";

type AskedEvent = { request: { requestId: string; waitForAnswer?: boolean; questions: { header: string }[] } };
type ClosedEvent = { requestId: string };
type ActiveAgentEvent = { agent?: string };

// The async question registers with the UI after `ask-user:asked` fires, so expanding
// it is retried briefly instead of assumed.
const EXPAND_ATTEMPTS = 10;
const EXPAND_INTERVAL_MS = 50;

export default function uiPrompt(pi: ExtensionAPI) {
	const state = createState();
	let tui: TUI | undefined;
	let editor: PromptEditor | undefined;
	let editorContainer: Container | undefined;
	let unhookContainer: (() => void) | undefined;
	let previousEditorFactory: ReturnType<ExtensionContext["ui"]["getEditorComponent"]> | undefined;
	let editorInstalled = false;
	let shuttingDown = false;
	let expandTimer: ReturnType<typeof setTimeout> | undefined;

	const render = () => tui?.requestRender();
	const theme = () => {
		const ctx = state.ctx;
		if (!ctx) throw new Error("ui-prompt: theme requested before session_start");
		return ctx.ui.theme;
	};

	const host: PromptHost = {
		state,
		theme,
		thinkingLevel: () => pi.getThinkingLevel(),
		emit: (event) => pi.events.emit(event, { agent: state.agent }),
		onMounted(mounted, mountedTui) {
			tui = mountedTui;
			editor = mounted;
			enableBarCursor(mountedTui);
			const container = findParentContainer(mountedTui, mounted);
			if (!container) return;
			editorContainer = container;
			hookQuestions();
		},
	};

	const wrapQuestion = (child: Component) => {
		if (!isQuestionComponent(child)) return undefined;
		const requestId = questionRequestId(child);
		if (requestId && state.question?.requestId === requestId) state.question.header = questionHeader(child);
		return new QuestionCard(child, theme);
	};
	// Re-run before each question too: another extension may have re-wrapped the container's
	// addChild since mount and dropped this hook (see hookAddChild).
	function hookQuestions() {
		if (!editorContainer) return;
		unhookContainer?.();
		unhookContainer = hookAddChild(editorContainer, wrapQuestion);
	}

	const questionMounted = () => editorContainer?.children.some((child) => child instanceof QuestionCard) ?? false;

	const expandAsyncQuestion = (requestId: string, attempt = 0) => {
		clearTimeout(expandTimer);
		expandTimer = undefined;
		if (state.question?.requestId !== requestId || questionMounted()) return;
		if (editor?.openPendingQuestion() || attempt >= EXPAND_ATTEMPTS) return;
		expandTimer = setTimeout(() => expandAsyncQuestion(requestId, attempt + 1), EXPAND_INTERVAL_MS);
	};

	const trackContext = (ctx: ExtensionContext) => {
		state.ctx = ctx;
	};
	// Shutdown hooks of other extensions can still start agent runs; the restored title
	// must outlive those, so title updates stop once shutdown has begun.
	const updateTitle = (ctx: ExtensionContext) => {
		if (!shuttingDown) applyTitle(pi, ctx, state);
	};

	registerTurnFooter(pi, state);

	pi.events.on("agents:active", (event: ActiveAgentEvent) => {
		state.agent = event?.agent?.trim() || DEFAULT_AGENT;
		render();
		if (state.ctx) updateTitle(state.ctx);
	});

	pi.events.on("ask-user:asked", (event: AskedEvent) => {
		hookQuestions();
		const { request } = event;
		state.question = {
			requestId: request.requestId,
			header: request.questions[0]?.header ?? "Question",
			blocking: request.waitForAnswer !== false,
		};
		if (!state.question.blocking) expandTimer = setTimeout(() => expandAsyncQuestion(request.requestId), 0);
	});

	pi.events.on("ask-user:closed", (event: ClosedEvent) => {
		if (state.question?.requestId === event.requestId) state.question = undefined;
		render();
	});

	pi.on("session_start", (_event, ctx) => {
		trackContext(ctx);
		if (!ctx.hasUI || ctx.mode !== "tui") return;
		shuttingDown = false;
		installWorkingIndicator(ctx, state);
		updateTitle(ctx);
		// A CustomEditor subclass cannot host another extension's editor instance (the engine
		// wires submit, autocomplete and paste into one component), so a previously set
		// factory is kept only to be restored when this one is removed.
		if (!editorInstalled) previousEditorFactory = ctx.ui.getEditorComponent();
		editorInstalled = true;
		ctx.ui.setEditorComponent((editorTui, editorTheme, keybindings) => new PromptEditor(editorTui, editorTheme, keybindings, host));
	});

	pi.on("session_info_changed", (_event, ctx) => {
		trackContext(ctx);
		updateTitle(ctx);
	});

	pi.on("turn_start", (_event, ctx) => {
		trackContext(ctx);
		updateTitle(ctx);
	});

	pi.on("agent_start", (_event, ctx) => {
		trackContext(ctx);
		state.busy = true;
		state.runStartedAt = Date.now();
		updateTitle(ctx);
		render();
	});

	pi.on("agent_settled", (_event, ctx) => {
		trackContext(ctx);
		state.busy = false;
		state.runStartedAt = undefined;
		updateTitle(ctx);
		render();
	});

	pi.on("model_select", (_event, ctx) => {
		trackContext(ctx);
		render();
	});

	pi.on("thinking_level_select", (_event, ctx) => {
		trackContext(ctx);
		render();
	});

	pi.on("session_shutdown", (_event, ctx) => {
		shuttingDown = true;
		clearTimeout(expandTimer);
		unhookContainer?.();
		unhookContainer = undefined;
		if (tui) restoreCursor(tui);
		restoreTitle(ctx);
		if (editorInstalled && ctx.hasUI) ctx.ui.setEditorComponent(previousEditorFactory);
		editorInstalled = false;
	});
}

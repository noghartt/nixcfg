import { CustomEditor, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, matchesKey, stripTerminalSequences, type TUI } from "@earendil-works/pi-tui";
import { cardLine, INFO_SEPARATOR, PROMPT_BAR, PROMPT_BG, splitLine } from "./card";
import { type ChordTarget, chordHint, LEADER_KEY, resolveChord } from "./chords";
import { type PromptState, shortModel } from "./state";

export type PromptHost = {
	state: PromptState;
	theme(): Theme;
	thinkingLevel(): string;
	emit(event: string): void;
	onMounted(editor: PromptEditor, tui: TUI): void;
};

type StatusIndicator = { renderInBorder(width: number): string };

// Fields the engine sets on the editor that its typings do not declare.
type EditorInternals = {
	renderedVisibleLineCount?: number;
	workingStatusIndicator?: StatusIndicator;
	onExtensionShortcut?: (data: string) => boolean;
	getPasteState?: () => unknown;
	setPasteState?: (state: unknown) => void;
};

const QUESTION_ANSWER_ACTION = "app.question.answer";
// Raw sequences for the default `app.question.answer` keys; the engine matches these
// through its keybindings, so only sequences it accepts are ever replayed.
const ANSWER_KEY_SEQUENCES: Record<string, string> = { "alt+up": "\x1b[1;3A", "alt+a": "\x1ba" };

function scrollNote(top: string, bottom: string): string | undefined {
	const note = /[\u2191\u2193] \d+ more/.exec(`${stripTerminalSequences(top)} ${stripTerminalSequences(bottom)}`);
	return note?.[0];
}

export class PromptEditor extends CustomEditor implements ChordTarget {
	private readonly host: PromptHost;
	private readonly promptTui: TUI;
	private readonly promptKeybindings: KeybindingsManager;
	private pendingLeader: string | undefined;
	private leaderToReplay: string | undefined;
	private mounted = false;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager, host: PromptHost) {
		super(tui, theme, keybindings, { embedWorkingStatus: true });
		this.host = host;
		this.promptTui = tui;
		this.promptKeybindings = keybindings;
		this.setPaddingX(0);
	}

	// The card's bar is the prompt marker, so the base editor's own padding is pinned to one
	// column and CustomEditor's `❯ ` gutter (which needs two) is bypassed in render().
	override setPaddingX(_padding: number): void {
		Editor.prototype.setPaddingX.call(this, 1);
	}

	override render(width: number): string[] {
		if (width < 8) return super.render(width);
		if (!this.mounted) {
			this.mounted = true;
			this.host.onMounted(this, this.promptTui);
		}
		const theme = this.host.theme();
		const inner = width - 1;
		const raw = Editor.prototype.render.call(this, inner) as string[];
		const bodyCount = (this as EditorInternals).renderedVisibleLineCount ?? Math.max(0, raw.length - 2);
		const body = raw.slice(1, bodyCount + 1);
		const autocomplete = raw.slice(bodyCount + 2);
		const style = { bar: PROMPT_BAR, bg: PROMPT_BG } as const;
		const lines = body.map((line) => cardLine(theme, style, line, width));
		const info = this.infoLine(theme, inner - 2, scrollNote(raw[0] ?? "", raw[bodyCount + 1] ?? ""));
		lines.push(cardLine(theme, style, ` ${info} `, width));
		for (const line of autocomplete) lines.push(cardLine(theme, style, line, width));
		return lines;
	}

	private infoLine(theme: Theme, width: number, note: string | undefined): string {
		const identity = this.identity(theme);
		const working = (this as EditorInternals).workingStatusIndicator?.renderInBorder(width);
		if (this.pendingLeader !== undefined) return splitLine(chordHint(theme), working || identity, width);
		if (working) return splitLine(working, identity, width);
		return splitLine(identity, note ? theme.fg("dim", note) : "", width);
	}

	private identity(theme: Theme): string {
		const { state } = this.host;
		const model = shortModel(state.ctx);
		const level = this.host.thinkingLevel();
		const thinkingColor = theme.getThinkingBorderColor?.(level) ?? ((text: string) => theme.fg("muted", text));
		const parts = [
			theme.fg("accent", state.agent),
			`${theme.fg("muted", model.id)}${model.provider ? theme.fg("dim", ` ${model.provider}`) : ""}`,
			thinkingColor(level),
		];
		if (state.ctx?.hasPendingMessages?.()) parts.push(theme.fg("warning", "queued"));
		return parts.join(theme.fg("dim", INFO_SEPARATOR));
	}

	override handleInput(data: string): void {
		if (this.pendingLeader !== undefined) {
			const leader = this.pendingLeader;
			this.pendingLeader = undefined;
			const resolution = resolveChord(data);
			if (resolution.kind === "cancel") return this.promptTui.requestRender();
			if (resolution.kind === "run") {
				this.leaderToReplay = leader;
				resolution.chord.run(this);
				this.leaderToReplay = undefined;
				return this.promptTui.requestRender();
			}
		} else if (matchesKey(data, LEADER_KEY) && !this.isShowingAutocomplete()) {
			this.pendingLeader = data;
			return this.promptTui.requestRender();
		}
		if (matchesKey(data, "tab") && this.getText() === "" && !this.isShowingAutocomplete()) {
			this.host.emit("agents:cycle");
			return;
		}
		super.handleInput(data);
	}

	replayLeader(): void {
		if (this.leaderToReplay !== undefined) super.handleInput(this.leaderToReplay);
	}

	emit(event: string): void {
		this.host.emit(event);
	}

	// Slash commands need the app's submit handler for their command context. That handler
	// reads the live editor text and clears it, so the draft is swapped out and back around it.
	runCommand(command: string): void {
		const internals = this as EditorInternals;
		const draft = this.getText();
		const paste = internals.getPasteState?.();
		this.setText(command);
		this.onSubmit?.(command);
		this.setText(draft);
		if (paste !== undefined) internals.setPasteState?.(paste);
	}

	// Replays the engine's own "open the pending question" key so OmO keeps owning the
	// question state; only sequences the current keybindings accept are sent.
	openPendingQuestion(): boolean {
		const shortcut = (this as EditorInternals).onExtensionShortcut;
		if (typeof shortcut !== "function") return false;
		const keys = this.promptKeybindings.getKeys?.(QUESTION_ANSWER_ACTION) ?? Object.keys(ANSWER_KEY_SEQUENCES);
		for (const key of keys) {
			const sequence = ANSWER_KEY_SEQUENCES[key];
			if (sequence && this.promptKeybindings.matches(sequence, QUESTION_ANSWER_ACTION)) return shortcut(sequence);
		}
		return false;
	}

	override handleMouse(event: { x: number; y: number; width: number } & Record<string, unknown>) {
		return super.handleMouse({ ...event, x: event.x - 1, y: event.y + 1, width: Math.max(1, event.width - 1) });
	}
}

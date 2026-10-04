import type { Theme } from "@earendil-works/pi-coding-agent";
import { type Component, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { cardLine, INFO_SEPARATOR, PROMPT_BG, QUESTION_BAR, splitLine } from "./card";

type QuestionState = {
	request?: { requestId?: string; questions?: { header?: string }[] };
	activeQuestion?: { header?: string };
};

export type QuestionComponent = Component & {
	children: unknown[];
	state: QuestionState;
	hintsText?: Component;
	handleInput(data: string): void;
	handleMouse?: (event: unknown) => unknown;
	dispose?: () => void;
};

const UNWRAPPED_WIDTH = 4000;

const BAR_AND_PAD = 2;

// The engine mounts its question in place of the editor; it is recognised by shape
// because the class is not exported.
export function isQuestionComponent(value: unknown): value is QuestionComponent {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<QuestionComponent>;
	return (
		Array.isArray(candidate.children) &&
		typeof candidate.handleInput === "function" &&
		typeof candidate.render === "function" &&
		Array.isArray(candidate.state?.request?.questions)
	);
}

export function questionHeader(question: QuestionComponent): string {
	return question.state.activeQuestion?.header ?? question.state.request?.questions?.[0]?.header ?? "Question";
}

export function questionRequestId(question: QuestionComponent): string | undefined {
	return question.state.request?.requestId;
}

function isBlank(line: string | undefined): boolean {
	return stripTerminalSequences(line ?? "").trim() === "";
}

function sameLines(a: string[], b: string[]): boolean {
	return a.length === b.length && a.every((line, index) => line === b[index]);
}

// Draws the engine's question inside the prompt card: its two horizontal rules go, its
// key-hint line moves to the info line, and input still reaches the wrapped component
// directly because the engine focuses that, not this frame.
export class QuestionCard implements Component {
	private leadingBlankLines = 0;

	constructor(
		private readonly question: QuestionComponent,
		private readonly theme: () => Theme,
	) {
		// ui-chrome draws whatever replaces the editor as a modal and skips only the engine's own
		// question class; this marker keeps the card in the prompt instead of a modal.
		(this as unknown as Record<symbol, boolean>)[Symbol.for("omo-ui-chrome.inline")] = true;
	}

	private hintsComponent(): Component | undefined {
		const hints = this.question.hintsText;
		return hints && typeof hints.render === "function" ? hints : undefined;
	}

	render(width: number): string[] {
		if (width < 8) return this.question.render(width);
		const theme = this.theme();
		const inner = width - BAR_AND_PAD;
		const infoWidth = inner - 1;
		const rendered = this.question.render(inner);
		const body = rendered.slice(1, -1);
		while (body.length > 0 && isBlank(body[body.length - 1])) body.pop();

		const title = `${theme.fg("warning", "Question")}${theme.fg("dim", INFO_SEPARATOR)}${theme.fg("muted", questionHeader(this.question))}`;
		let info = title;
		const hints = this.hintsComponent();
		if (hints) {
			const hintLines = hints.render(inner);
			const hintText = (hints.render(UNWRAPPED_WIDTH)[0] ?? "").trim();
			const tail = body.slice(body.length - hintLines.length);
			const fits = visibleWidth(title) + 1 + visibleWidth(hintText) <= infoWidth;
			if (fits && hintLines.length > 0 && sameLines(tail, hintLines)) {
				body.length -= hintLines.length;
				info = splitLine(title, hintText, infoWidth);
			}
		}

		let leading = 0;
		while (leading < body.length && isBlank(body[leading])) leading++;
		this.leadingBlankLines = leading;

		const style = { bar: QUESTION_BAR, bg: PROMPT_BG } as const;
		const lines = body.slice(leading).map((line) => cardLine(theme, style, ` ${line}`, width));
		lines.push(cardLine(theme, style, ` ${splitLine(info, "", infoWidth)} `, width));
		return lines;
	}

	invalidate(): void {
		this.question.invalidate?.();
	}

	dispose(): void {
		this.question.dispose?.();
	}

	handleMouse(event: { x: number; y: number; width: number } & Record<string, unknown>) {
		return this.question.handleMouse?.({
			...event,
			x: event.x - BAR_AND_PAD,
			y: event.y + 1 + this.leadingBlankLines,
			width: Math.max(1, event.width - BAR_AND_PAD),
		});
	}
}

// Notice cards: OmO's inline notices (turn errors, warnings, notice boxes,
// cache-miss and continuity notes, project trust) and the custom messages and
// entries its built-in extensions and plugins add (loop guard, /loop ticks,
// rule activations, MCP authorization, task completions, memory notices).
// The stock components keep building the content; it is redrawn on a card.
import { type Component, type CardStyle, cardRow, stripAnsi, type Theme } from "./core/style.ts";
import { type NoticeTone, onTranscriptNotice, theme } from "./core/host.ts";

const LEADING_OSC = /^(?:\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))+/;
// Stock notice boxes paint their own background (customMessageBg); it is
// dropped so every notice shares the card fill.
const BACKGROUND = /\x1b\[(?:48;(?:2;\d+;\d+;\d+|5;\d+)|4[0-7]|10[0-7])m/g;

export type Tone = "error" | "warning" | "muted" | "success" | "accent";

const STYLES: Record<Tone, CardStyle> = {
	error: { tone: "error", bg: "toolErrorBg" },
	warning: { tone: "warning", bg: "toolPendingBg" },
	muted: { tone: "muted", bg: "toolPendingBg" },
	success: { tone: "success", bg: "toolPendingBg" },
	accent: { tone: "accent", bg: "toolPendingBg" },
};

// Rows of the stock component rendered one column narrower, without its own
// padding and background. Spacer rows around it stay outside the card, and
// blank rows at the card's edges collapse so the card hugs its text.
export function noticeCard(th: Theme, tone: Tone, lines: string[], width: number): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && stripAnsi(lines[start]!).trim() === "") start++;
	while (end > start && stripAnsi(lines[end - 1]!).trim() === "") end--;
	if (start === end) return lines;
	const lead = lines.slice(0, start).length > 0 ? [""] : [];
	const body = lines.slice(start, end).map((line) => {
		const osc = LEADING_OSC.exec(line)?.[0] ?? "";
		const text = line.slice(osc.length).replace(BACKGROUND, "").replace(/^((?:\x1b\[[0-9;]*m)*) /, "$1");
		return osc + cardRow(th, STYLES[tone], text, width);
	});
	return [...lead, ...body];
}

export function customTone(customType: string | undefined): Tone {
	const type = (customType ?? "").toLowerCase();
	if (/error|fail|denied|block/.test(type)) return "error";
	if (/complet|done|success|wake/.test(type)) return "success";
	if (/rule|skill|memory|hexis/.test(type)) return "accent";
	return "warning";
}

function asCard(component: Component, tone: NoticeTone): Component {
	return {
		invalidate: () => component.invalidate(),
		handleMouse: component.handleMouse?.bind(component),
		dispose: component.dispose?.bind(component),
		render(width: number): string[] {
			const th = theme();
			const lines = component.render(width - 1);
			return th ? noticeCard(th, tone, lines, width) : component.render(width);
		},
	};
}

export default function notices(): void {
	onTranscriptNotice((tone, component) => asCard(component, tone));
}

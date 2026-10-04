import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// Shared visual language with ui-chrome: a one-column bar on a filled panel.
export const CARD_BAR = "\u2503";
export const INFO_SEPARATOR = " \u00b7 ";
// The prompt shares the user-message background: both are the user's own words.
export const PROMPT_BG = "userMessageBg";
export const PROMPT_BAR = "accent";
// A question waiting on the user is attention-coloured, like a warning border.
export const QUESTION_BAR = "warning";

type ThemeFg = Parameters<Theme["fg"]>[0];
type ThemeBg = Parameters<Theme["bg"]>[0];

export type CardStyle = { bar: ThemeFg; bg: ThemeBg };

function backgroundCodes(theme: Theme, token: ThemeBg): { start: string; end: string } {
	const probe = theme.bg(token, "\u0000");
	const index = probe.indexOf("\u0000");
	if (index === -1) return { start: "", end: "" };
	return { start: probe.slice(0, index), end: probe.slice(index + 1) };
}

// Re-arms the background after every SGR reset inside the line: the editor's fake cursor
// and theme.fg() spans end in resets that would otherwise punch holes in the panel.
export function fillBackground(theme: Theme, token: ThemeBg, line: string, width: number): string {
	const { start, end } = backgroundCodes(theme, token);
	const clipped = truncateToWidth(line, width, "");
	const pad = " ".repeat(Math.max(0, width - visibleWidth(clipped)));
	if (start === "") return `${clipped}${pad}`;
	const restored = clipped.replace(/\x1b\[([0-9;]*)m/g, (sequence, params: string) => {
		const codes = params === "" ? ["0"] : params.split(";");
		return codes.some((code) => code === "0" || code === "49") ? `${sequence}${start}` : sequence;
	});
	return `${start}${restored}${pad}${end}`;
}

export function cardLine(theme: Theme, style: CardStyle, content: string, width: number): string {
	if (width <= 1) return truncateToWidth(theme.fg(style.bar, CARD_BAR), width, "");
	return fillBackground(theme, style.bg, `${theme.fg(style.bar, CARD_BAR)}${content}`, width);
}

export function splitLine(left: string, right: string, width: number): string {
	const leftWidth = visibleWidth(left);
	const rightWidth = visibleWidth(right);
	if (rightWidth > 0 && leftWidth + 1 + rightWidth <= width) {
		return `${left}${" ".repeat(width - leftWidth - rightWidth)}${right}`;
	}
	return truncateToWidth(left, width, "\u2026");
}

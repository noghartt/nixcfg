// Shared drawing helpers: ANSI handling, background fills and the card shape
// every surface (and the sibling ui-prompt extension) uses. Public pi-tui API only.
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export type Theme = {
	fg(token: string, text: string): string;
	bg(token: string, text: string): string;
	bold(text: string): string;
	italic?(text: string): string;
};

export type Component = {
	render(width: number): string[];
	invalidate(): void;
	handleInput?(data: string): void;
	handleMouse?(event: MouseEvent): unknown;
	dispose?(): void;
	focused?: boolean;
};

export type MouseEvent = { x: number; y: number; width: number; height: number; type?: string; button?: string };

// CSI (colours, cursor), OSC (hyperlinks, shell zones) and APC (the IME cursor marker).
const ESCAPES = /\x1b\[[0-9;:?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b_[^\x07\x1b]*(?:\x07|\x1b\\)/g;

export function stripAnsi(text: string): string {
	return text.replace(ESCAPES, "");
}

// The SGR a theme token opens with. `as` moves it to the other layer, so a
// foreground token can paint a background (the selection bar) and vice versa.
export function sgr(theme: Theme, token: string, layer: "fg" | "bg", as: "fg" | "bg" = layer): string {
	const open = (layer === "fg" ? theme.fg(token, "\u0000") : theme.bg(token, "\u0000")).split("\u0000")[0] ?? "";
	if (layer === as) return open;
	return as === "bg" ? open.replace("\x1b[38;", "\x1b[48;").replace(/\x1b\[3([0-7])m/, "\x1b[4$1m").replace(/\x1b\[9([0-7])m/, "\x1b[10$1m")
		: open.replace("\x1b[48;", "\x1b[38;").replace(/\x1b\[4([0-7])m/, "\x1b[3$1m").replace(/\x1b\[10([0-7])m/, "\x1b[9$1m");
}

// Styled spans end with targeted resets (49m, 0m) that would punch holes into a
// filled row, so the background is reopened after each one before padding.
export function fill(open: string, line: string, width: number): string {
	if (width <= 0) return "";
	const fitted = visibleWidth(line) > width ? truncateToWidth(line, width, overflowIsBlank(line, width) ? "" : "…") : line;
	const body = fitted.replaceAll("\x1b[0m", `\x1b[0m${open}`).replaceAll("\x1b[49m", `\x1b[49m${open}`);
	return `${open}${body}${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}\x1b[0m`;
}

// Stock rows padded to their own width only overflow a card by trailing
// spaces, which should be cut without an ellipsis.
function overflowIsBlank(line: string, width: number): boolean {
	return stripAnsi(line).slice(width).trim() === "";
}

export function spread(left: string, right: string, width: number): string {
	const gap = width - visibleWidth(left) - visibleWidth(right);
	return gap >= 1 ? `${left}${" ".repeat(gap)}${right}` : truncateToWidth(left, width, "…");
}

export function wrap(text: string, width: number): string[] {
	return text.split("\n").flatMap((line) => (line ? wrapTextWithAnsi(line, Math.max(1, width)) : [""]));
}

export const GLYPH = { bar: "┃", thin: "▏" } as const;

export type CardTone = "accent" | "muted" | "dim" | "success" | "error" | "warning";
export type CardStyle = { tone: CardTone; bg?: string; glyph?: string };

// One card row: the coloured bar, then the content on the card background with
// one column of inner padding.
export function cardRow(theme: Theme, style: CardStyle, text: string, width: number): string {
	const bar = theme.fg(style.tone, style.glyph ?? GLYPH.bar);
	const inner = Math.max(1, width - 1);
	const content = ` ${text}`;
	if (!style.bg) return bar + truncateToWidth(content, inner, overflowIsBlank(content, inner) ? "" : "…");
	return bar + fill(sgr(theme, style.bg, "bg"), content, inner);
}

export function card(theme: Theme, style: CardStyle, lines: string[], width: number): string[] {
	return lines.map((line) => cardRow(theme, style, line, width));
}

export function cardInner(width: number): number {
	return Math.max(1, width - 2);
}

export function isBlank(line: string): boolean {
	return stripAnsi(line).trim() === "";
}

export function trimBlank(lines: string[]): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && isBlank(lines[start]!)) start++;
	while (end > start && isBlank(lines[end - 1]!)) end--;
	return lines.slice(start, end);
}

export function plural(n: number, noun: string): string {
	return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

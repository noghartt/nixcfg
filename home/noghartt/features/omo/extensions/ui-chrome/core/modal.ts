// opencode-style modal: a centred panel on a filled background with a header
// row, a highlighted selection bar and key hints at the bottom. Drawing only;
// placement and backdrop come from host.ts and backdrop.ts.
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type Component, fill, sgr, spread, stripAnsi, type Theme, trimBlank, wrap } from "./style.ts";

export const MODAL_WIDTH = 88;
export const WIDE_MODAL_WIDTH = 120;
export const PANEL_BG = "toolPendingBg";
const INSET = 3;
// Rows the frame adds around a body: pad, header, pad, ..., pad, hints, pad.
export const CHROME_ROWS = 6;

export type Hint = [label: string, keys: string];

export function modalFrame(theme: Theme, width: number) {
	const panel = sgr(theme, PANEL_BG, "bg");
	const inner = Math.max(1, width - 2 * INSET);
	const line = (text = "") => fill(panel, `${" ".repeat(INSET)}${truncateToWidth(text, inner, "…")}`, width);
	return {
		inner,
		line,
		header: (title: string, right = "esc") => line(spread(theme.bold(title), theme.fg("muted", right), inner)),
		hints: (hints: Hint[]) => hints.map(([label, keys]) => `${theme.fg("text", label)} ${theme.fg("muted", keys)}`).join("   "),
		// The selected row: a bar in the accent colour, one column wider than the
		// text on each side, with the text in the panel colour.
		highlight: (text: string) => {
			const bar = sgr(theme, "accent", "fg", "bg");
			const ink = sgr(theme, PANEL_BG, "bg", "fg");
			const row = fill(bar, ` ${" ".repeat(INSET - 2)}${ink}\x1b[1m${truncateToWidth(stripAnsi(text), inner, "…")}`, width - 2);
			return fill(panel, ` ${row}`, width);
		},
	};
}

export type Frame = ReturnType<typeof modalFrame>;

const BORDER = /^[\s─━═┄┈╌-]+$/;
const MARKER = /^(\s{0,3})([→›]) /;
const HINT = /\b(esc|enter|tab|ctrl\+|shift\+|alt\+)|[↑↓←→]/i;

// Rows omo's stock screens draw that the frame replaces: border rules go, the
// first content row becomes the header, a trailing key-hint row moves to the
// footer, and the row behind the selection marker becomes the highlight bar.
export function splitStock(lines: string[], title: string | undefined, scrolling = false) {
	const rows = trimBlank(lines.filter((line) => !BORDER.test(stripAnsi(line)) || stripAnsi(line).trim() === ""));
	if (scrolling) return { header: title ?? "", body: rows, hints: undefined, selected: undefined };
	let header = title;
	if (header === undefined && rows.length > 1) header = stripAnsi(rows.shift() ?? "").trim();
	let hints: string | undefined;
	const last = rows.at(-1);
	if (last !== undefined && rows.length > 1 && HINT.test(stripAnsi(last)) && /[•·]|\s{2,}/.test(stripAnsi(last).trim())) {
		hints = stripAnsi(rows.pop() ?? "").trim();
	}
	const body = trimBlank(rows);
	const marked = body.flatMap((line, index) => (MARKER.test(stripAnsi(line)) ? [index] : []));
	const selected = marked.length === 1 ? marked[0] : undefined;
	return { header: header ?? "", body, hints, selected };
}

export function windowed<T>(rows: T[], selected: number | undefined, room: number): { rows: T[]; offset: number } {
	if (rows.length <= room) return { rows, offset: 0 };
	const anchor = selected ?? 0;
	const offset = Math.max(0, Math.min(anchor - Math.floor(room / 2), rows.length - room));
	return { rows: rows.slice(offset, offset + room), offset };
}

export function bodyRoom(rows: number, extra = 0): number {
	return Math.max(3, rows - 2 - CHROME_ROWS - extra);
}

// A stock omo screen drawn inside the frame. omo keeps focus on its own
// component, so this only renders; keys reach it only if focus lands here.
export function stockModal(stock: Component, options: { theme: () => Theme | undefined; rows: () => number; title?: string; fallbackTitle?: string; hints?: Hint[]; scrolling?: boolean }): Component {
	return {
		get focused() {
			return stock.focused ?? false;
		},
		set focused(value: boolean) {
			stock.focused = value;
		},
		invalidate: () => stock.invalidate(),
		handleInput: (data: string) => stock.handleInput?.(data),
		render(width: number): string[] {
			const theme = options.theme();
			if (!theme) return stock.render(width);
			const f = modalFrame(theme, width);
			const parts = splitStock(stock.render(f.inner), options.title, options.scrolling);
			if (options.fallbackTitle && /^(>.*)?$/.test(parts.header.trim())) parts.header = options.fallbackTitle;
			const shown = windowed(parts.body, parts.selected, bodyRoom(options.rows()));
			const body = shown.rows.map((line, index) => {
				if (index + shown.offset !== parts.selected) return f.line(line);
				return f.highlight(stripAnsi(line).replace(MARKER, "$1  "));
			});
			const hints = options.hints ? f.hints(options.hints) : parts.hints ? theme.fg("muted", parts.hints) : undefined;
			return [f.line(), f.header(parts.header), f.line(), ...body, f.line(), ...(hints ? [f.line(hints), f.line()] : [])];
		},
	};
}

export function textModal(options: {
	theme: () => Theme | undefined;
	rows: () => number;
	title: string;
	tone?: string;
	render: (width: number) => string[];
	requestRender: () => void;
	close: () => void;
}): Component {
	let top = 0;
	let page = 1;
	return {
		invalidate() {},
		render(width: number): string[] {
			const theme = options.theme();
			if (!theme) return options.render(width);
			const f = modalFrame(theme, width);
			const body = trimBlank(options.render(f.inner));
			page = bodyRoom(options.rows());
			top = Math.max(0, Math.min(top, body.length - page));
			const scrolls = body.length > page;
			const position = theme.fg("muted", `${top + 1}-${Math.min(top + page, body.length)} of ${body.length}`);
			const title = options.tone ? theme.fg(options.tone, options.title) : options.title;
			const hints: Hint[] = scrolls ? [["scroll", "↑↓"], ["page", "pgup/pgdn"], ["close", "esc"]] : [["close", "esc"]];
			const footer = scrolls ? spread(f.hints(hints), position, f.inner) : f.hints(hints);
			return [f.line(), f.header(title), f.line(), ...body.slice(top, top + page).map((l) => f.line(l)), f.line(), f.line(footer), f.line()];
		},
		handleInput(data: string) {
			if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter) || data === "q") return options.close();
			const step = matchesKey(data, Key.up) || data === "k" ? -1 : matchesKey(data, Key.down) || data === "j" ? 1 : 0;
			const jump = matchesKey(data, Key.pageUp) ? -page : matchesKey(data, Key.pageDown) || data === " " ? page : 0;
			if (step || jump) {
				top = Math.max(0, top + step + jump);
				options.requestRender();
			}
		},
	};
}

export function wrapText(text: string, width: number): string[] {
	return wrap(text, width).map((line) => (visibleWidth(line) > width ? truncateToWidth(line, width, "…") : line));
}

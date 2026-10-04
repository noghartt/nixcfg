// Every screen OmO puts in the prompt's place (extension select/confirm/input/
// editor dialogs, model and thinking pickers, /tree, /fork, /resume, /settings,
// /trust, /login, /logout, /diff, /files), the stock overlay panels (/help,
// /history), multi-line ctx.ui.notify output and the transcript panels
// (/hotkeys, /session, /changelog) are drawn as modals. OmO keeps each screen's
// keys, state, search and result; these only redraw.
import { CHROME_ROWS, MODAL_WIDTH, stockModal, textModal, WIDE_MODAL_WIDTH, wrapText } from "./core/modal.ts";
import { onEditorScreen, onNotify, onStockOverlay, onTranscriptPanel, type OverlayHandle, showModal, theme, tui } from "./core/host.ts";
import { type Component, stripAnsi, trimBlank } from "./core/style.ts";

const rows = () => tui()?.terminal.rows ?? 24;
const WIDE = new Set(["TreeSelectorComponent", "SessionSelectorComponent"]);
const BORDER = /^[\s─━═]+$/;
// Screens whose first row is not a title (the model picker opens with its
// catalog toggle) get a fixed one; the rest keep the title omo draws.
const TITLES: Record<string, string> = { ModelSelectorComponent: "Select model" };

// Stock panels that scroll their own content: their first row is content,
// not a title, so the frame gets a fixed title and no hint extraction.
const SCROLLING: Record<string, string> = { HelpPanel: "Help" };

function openText(title: string, tone: string | undefined, render: (width: number) => string[]): void {
	let handle: OverlayHandle | undefined;
	const modal = textModal({
		theme,
		rows,
		title,
		tone,
		render,
		requestRender: () => tui()?.requestRender(),
		close: () => handle?.hide(),
	});
	handle = showModal(modal, MODAL_WIDTH);
}

const NOTIFY_TITLES: Record<string, [string, string | undefined]> = {
	error: ["Error", "error"],
	warning: ["Warning", "warning"],
	info: ["Notice", undefined],
};

// /goal, /todo, /mcp status, /hooks and similar print a block of lines. A
// short first line reads as the block's own heading, so it becomes the title.
function notifyTitle(message: string, type: string | undefined): { title: string; tone: string | undefined; body: string } {
	const [fallback, tone] = NOTIFY_TITLES[type ?? "info"] ?? NOTIFY_TITLES.info!;
	const [first = "", ...rest] = message.split("\n");
	const heading = stripAnsi(first).trim().replace(/:$/, "");
	if (heading && heading.length <= 60 && rest.some((line) => line.trim())) return { title: heading, tone, body: rest.join("\n") };
	return { title: fallback, tone, body: message };
}

// The panel's own heading row repeats the modal title, so it is dropped.
function panelLines(parts: Component[], width: number): string[] {
	const lines = trimBlank(parts.flatMap((part) => part.render(width)).filter((line) => !BORDER.test(stripAnsi(line)) || !stripAnsi(line).trim()));
	return lines.slice(1);
}

const PANEL_TITLES = { hotkeys: "Keyboard shortcuts", session: "Session", changelog: "What's new" } as const;

// A derived header that is really a search field or empty falls back to the
// screen's class name: SettingsSelectorComponent reads as "Settings".
function classTitle(name: string): string | undefined {
	const words = name.replace(/(Selector)?Component$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
	return words ? words.charAt(0) + words.slice(1).toLowerCase() : undefined;
}

export default function dialogs(): void {
	onEditorScreen(({ name, stock }) => ({
		component: stockModal(stock, { theme, rows, title: TITLES[name], fallbackTitle: classTitle(name) }),
		width: WIDE.has(name) ? WIDE_MODAL_WIDTH : MODAL_WIDTH,
	}));

	onStockOverlay(({ name, stock }) => {
		if (name === "HelpPanel") {
			// The panel sizes its scroll window from the terminal; the frame's
			// rows come out of that window so the last lines stay reachable.
			const panel = stock as Component & { viewportHeight?: () => number };
			const viewport = panel.viewportHeight?.bind(panel);
			if (viewport) panel.viewportHeight = () => Math.max(1, viewport() - CHROME_ROWS);
			return { component: stockModal(stock, { theme, rows, title: SCROLLING[name], scrolling: true, hints: [["scroll", "↑↓"], ["page", "pgup/pgdn"], ["close", "esc"]] }), width: WIDE_MODAL_WIDTH };
		}
		if (name === "HistorySearchOverlay") return { component: stockModal(stock, { theme, rows }), width: WIDE_MODAL_WIDTH };
		return undefined;
	});

	onNotify((message, type) => {
		const text = message.trim();
		if (!text.includes("\n") || !tui()) return false;
		const { title, tone, body } = notifyTitle(text, type);
		openText(title, tone, (width) => wrapText(body, width));
		return true;
	});

	onTranscriptPanel((panel, parts) => {
		if (!tui()) return false;
		openText(PANEL_TITLES[panel], undefined, (width) => panelLines(parts, width));
		return true;
	});
}

import { type ExtensionContext, keyText, type Theme } from "@earendil-works/pi-coding-agent";
import { formatDuration, type PromptState } from "./state";

// A three-cell scan; slow enough to read as "alive" without flicker.
const SCAN_FRAMES = ["\u25ae\u25af\u25af", "\u25af\u25ae\u25af", "\u25af\u25af\u25ae", "\u25af\u25ae\u25af"];
const SCAN_INTERVAL_MS = 240;
const MESSAGE_INTERVAL_MS = 1000;

// The engine's own options carry these formatter hooks; the public typings only name
// frames and intervalMs, so the full shape is spelled out here.
type WorkingIndicatorOptions = {
	frames: string[];
	intervalMs: number;
	indicatorFormatter?: (frame: string, elapsedMs: number) => string;
	messageFormatter?: (message: string, elapsedMs: number) => string;
	messageIntervalMs?: number;
};

export function workingIndicator(theme: () => Theme, state: PromptState): WorkingIndicatorOptions {
	return {
		frames: SCAN_FRAMES,
		intervalMs: SCAN_INTERVAL_MS,
		indicatorFormatter: (frame) => theme().fg("accent", frame),
		messageIntervalMs: MESSAGE_INTERVAL_MS,
		messageFormatter: (message) => {
			const t = theme();
			const elapsed = state.runStartedAt === undefined ? "" : `${formatDuration(Date.now() - state.runStartedAt)} \u00b7 `;
			const queued = state.ctx?.hasPendingMessages?.() ? t.fg("warning", " \u00b7 queued") : "";
			return `${t.fg("text", message)}${t.fg("dim", ` (${elapsed}${keyText("app.interrupt")} to interrupt)`)}${queued}`;
		},
	};
}

export function installWorkingIndicator(ctx: ExtensionContext, state: PromptState): void {
	if (!ctx.hasUI) return;
	const setWorkingIndicator = ctx.ui.setWorkingIndicator as unknown as (options: WorkingIndicatorOptions) => void;
	setWorkingIndicator(workingIndicator(() => ctx.ui.theme, state));
}

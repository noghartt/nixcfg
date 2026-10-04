// Transcript cards: user messages on an accent card, `!cmd` runs as tool-style
// cards, compaction/branch summaries and skill invocations as notice cards,
// thinking dimmed behind a thin bar without blank lines, and turn errors as
// error cards. OmO still builds every component; these redraw its lines.
import { onAssistantPart, onTranscriptEntry, theme } from "./core/host.ts";
import { customTone, noticeCard } from "./notices.ts";
import { type CardStyle, cardRow, GLYPH, stripAnsi, type Theme } from "./core/style.ts";

// OSC 133 shell-integration zones open the first row; OmO strips them only at
// the start of a row, so they stay in front of the bar.
const LEADING_OSC = /^(?:\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))+/;

// A card around stock rows. Spacer rows ("") above and below stay outside
// the card; padded rows inside it (a filled blank line) are part of it.
export function cardAround(th: Theme, style: CardStyle, lines: string[], width: number): string[] {
	let start = 0;
	let end = lines.length;
	while (start < end && lines[start] === "") start++;
	while (end > start && lines[end - 1] === "") end--;
	const body = lines.slice(start, end).map((line) => {
		const osc = LEADING_OSC.exec(line)?.[0] ?? "";
		return osc + cardRow(th, style, unpad(line.slice(osc.length)), width);
	});
	return [...lines.slice(0, start), ...body, ...lines.slice(end)];
}

// Stock rows carry their own one-column padding, which becomes the card's.
const unpad = (line: string) => line.replace(/^((?:\x1b\[[0-9;]*m)*) /, "$1");

const BASH_TONE: Record<string, CardStyle["tone"]> = { running: "warning", complete: "success", error: "error", cancelled: "muted" };

export default function transcript(): void {
	onTranscriptEntry((entry, stock, width) => {
		const th = theme();
		if (!th) return stock(width);
		switch (entry.kind) {
			case "user":
				return cardAround(th, { tone: "accent", bg: "userMessageBg" }, stock(width - 1), width);
			case "bash": {
				const content = entry.content?.(width - 1) ?? [];
				if (content.length === 0) return stock(width);
				const tone = BASH_TONE[entry.status ?? "running"] ?? "muted";
				return ["", ...cardAround(th, { tone, bg: entry.status === "error" ? "toolErrorBg" : "toolPendingBg" }, content, width)];
			}
			case "compaction":
			case "branch":
				return noticeCard(th, "muted", stock(width - 1), width);
			case "skill":
				return noticeCard(th, "accent", stock(width - 1), width);
			case "custom-message":
			case "custom-entry":
				return noticeCard(th, customTone(entry.customType), stock(width - 1), width);
			default:
				return stock(width);
		}
	});

	onAssistantPart((part, stock, width) => {
		const th = theme();
		if (!th) return stock(width);
		if (part === "error-text") {
			return cardAround(th, { tone: "error", bg: "toolErrorBg" }, stock(width - 1), width);
		}
		const bar = th.fg("dim", GLYPH.thin);
		return stock(width - 1)
			.filter((line) => stripAnsi(line).trim() !== "")
			.map((line) => `${bar}${line}`);
	});
}

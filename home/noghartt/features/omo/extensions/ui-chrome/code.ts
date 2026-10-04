// Markdown code blocks as cards: a language header and the highlighted code on
// a filled background instead of ``` fences. Long lines wrap inside the card
// because Markdown would otherwise re-wrap them outside it.
import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { onCodeBlock, theme } from "./core/host.ts";
import { card, cardInner } from "./core/style.ts";

export default function code(): void {
	onCodeBlock(({ lang, width, highlight }) => {
		const th = theme();
		if (!th || width < 8) return undefined;
		const inner = cardInner(width) - 1;
		const header = th.fg("muted", lang || "text");
		const body = highlight().flatMap((line) => (line ? wrapTextWithAnsi(line.replace(/\t/g, "  "), inner) : [""]));
		return card(th, { tone: "dim", bg: "toolPendingBg" }, [header, ...body], width);
	});
}

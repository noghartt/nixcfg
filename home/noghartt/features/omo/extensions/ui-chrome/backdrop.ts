// Terminals have no translucency, so while a capturing overlay or one of our
// modals is open the frame under it is repainted flat: every cell keeps its
// text but drops its colours for one faint fg on the default background. That
// includes the statusline sidebar, which is part of the same layout frame.
import { visibleWidth } from "@earendil-works/pi-tui";
import { modalOpen, onFrame, theme } from "./core/host.ts";
import { sgr, stripAnsi } from "./core/style.ts";

// Kitty and iTerm image rows cannot be faded as text.
const IMAGE = /\x1b_G|\x1b\]1337;File=/;

export default function backdrop(): void {
	onFrame((screen, width) => {
		if (!modalOpen()) return screen;
		const th = theme();
		const ink = `\x1b[0m${th ? sgr(th, "dim", "fg") : "\x1b[90m"}\x1b[2m`;
		return screen.map((line) => {
			if (IMAGE.test(line)) return line;
			const text = stripAnsi(line);
			return `${ink}${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}\x1b[0m`;
		});
	});
}

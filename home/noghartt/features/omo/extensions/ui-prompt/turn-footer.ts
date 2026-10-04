import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { INFO_SEPARATOR } from "./card";
import { formatDuration, type PromptState, shortModel } from "./state";

export const TURN_ENTRY_TYPE = "ui-turn";
const TURN_GLYPH = "\u25a3";

type TurnData = { agent: string; model: string; durationMs: number };

export function registerTurnFooter(pi: ExtensionAPI, state: PromptState): void {
	pi.registerEntryRenderer(TURN_ENTRY_TYPE, (entry, _options, theme) => {
		const data = entry.data as Partial<TurnData> | undefined;
		const parts = [data?.agent ?? "omo", data?.model ?? "?", formatDuration(data?.durationMs ?? 0)];
		return new Text(theme.fg("dim", `${TURN_GLYPH} ${parts.join(INFO_SEPARATOR)}`), 0, 0);
	});

	pi.on("agent_end", (_event, ctx) => {
		if (ctx.mode !== "tui" || state.runStartedAt === undefined) return;
		const data: TurnData = {
			agent: state.agent,
			model: shortModel(ctx).id,
			durationMs: Date.now() - state.runStartedAt,
		};
		pi.appendEntry(TURN_ENTRY_TYPE, data);
	});
}

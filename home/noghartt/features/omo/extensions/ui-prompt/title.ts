import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { basename } from "node:path";
import { DEFAULT_AGENT, type PromptState } from "./state";

const BUSY_DOT = "\u25cf ";
const MAX_PROMPT_TITLE = 40;

function firstPrompt(ctx: ExtensionContext): string | undefined {
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const content = entry.message.content;
		const text =
			typeof content === "string"
				? content
				: content.find((part): part is { type: "text"; text: string } => part.type === "text")?.text;
		const line = text?.split("\n").find((candidate) => candidate.trim() !== "")?.trim();
		if (line) return line.length > MAX_PROMPT_TITLE ? `${line.slice(0, MAX_PROMPT_TITLE - 1)}\u2026` : line;
	}
	return undefined;
}

export function applyTitle(pi: ExtensionAPI, ctx: ExtensionContext, state: PromptState): void {
	if (!ctx.hasUI) return;
	const name = pi.getSessionName() || firstPrompt(ctx) || DEFAULT_AGENT;
	ctx.ui.setTitle(`${state.busy ? BUSY_DOT : ""}${name} \u00b7 ${basename(ctx.cwd)}`);
}

export function restoreTitle(ctx: ExtensionContext): void {
	if (ctx.hasUI) ctx.ui.setTitle(basename(ctx.cwd));
}

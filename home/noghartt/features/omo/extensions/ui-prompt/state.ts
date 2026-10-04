import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export const DEFAULT_AGENT = "omo";

export type PendingQuestion = { requestId: string; header: string; blocking: boolean };

export type PromptState = {
	agent: string;
	busy: boolean;
	runStartedAt: number | undefined;
	ctx: ExtensionContext | undefined;
	question: PendingQuestion | undefined;
};

export function createState(): PromptState {
	return { agent: DEFAULT_AGENT, busy: false, runStartedAt: undefined, ctx: undefined, question: undefined };
}

export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function shortModel(ctx: ExtensionContext | undefined): { id: string; provider: string } {
	const model = ctx?.model;
	return { id: model?.id ?? "no model", provider: model?.provider ?? "" };
}

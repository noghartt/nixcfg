import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const RELAY_NOTE =
	"A user message starting with [swarm] was sent by the user's agent swarm (its leader, a peer member, or the swarm daemon) on the user's behalf; treat it as the user's own message.";

export function text(value: string) {
	return { content: [{ type: "text" as const, text: value }], details: undefined };
}

// OmO prewarms the prompt cache only when every before_agent_start handler is preview-safe;
// these handlers only compose text. Pi's typings lack the option and Pi ignores it.
export function onBeforeAgentStart(
	pi: ExtensionAPI,
	handler: (event: { systemPrompt: string }) => Promise<{ systemPrompt: string } | undefined>,
): void {
	(pi.on as unknown as (...args: unknown[]) => void).call(pi, "before_agent_start", handler, { previewSafe: true });
}

export function lastAssistantText(ctx: ExtensionContext): string {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		return entry.message.content
			.flatMap((part) => (part.type === "text" ? [part.text] : []))
			.join("\n")
			.trim();
	}
	return "";
}

export function summarizeToolCall(name: string, args: unknown, isError: boolean): string {
	const record = (args ?? {}) as Record<string, unknown>;
	const detail = [record.command, record.path, record.code, record.pattern, record.to]
		.find((value): value is string => typeof value === "string")
		?.replace(/\s+/g, " ")
		.slice(0, 160);
	return `${name} ${isError ? "error" : "ok"}${detail ? `: ${detail}` : ""}`;
}

export function splitRef(ref: string): { provider: string; id: string } {
	const slash = ref.indexOf("/");
	return { provider: ref.slice(0, slash), id: ref.slice(slash + 1) };
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

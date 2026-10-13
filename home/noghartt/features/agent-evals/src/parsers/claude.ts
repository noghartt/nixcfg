import { emptyUsage, isObj, isoFrom, num, type Obj, type ParseResult, parseJsonLines, str, type Turn } from "../types.ts";

// Claude Code writes one entry per content block, all sharing message.id and usage.
// Agent SDK clients (entrypoint sdk-*) mirror a session another harness already
// recorded (OmO's claude-sdk provider writes one per OmO session), so they are
// skipped unless asked for, or every OmO turn would count twice.
const INJECTED_PREFIXES = ["<command-name>", "<command-message>", "<local-command-", "<system-reminder>", "Caveat:", "<user-prompt-submit-hook>"];

function blocks(content: unknown): Obj[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	return Array.isArray(content) ? content.filter(isObj) : [];
}

function resultText(content: unknown): string {
	if (typeof content === "string") return content;
	return blocks(content)
		.map((b) => (b.type === "text" ? String(b.text ?? "") : b.type === "image" ? "[image]" : ""))
		.filter(Boolean)
		.join("\n");
}

export function parseClaudeSession(text: string, path: string, opts: { includeSdk?: boolean } = {}): ParseResult {
	const entries = parseJsonLines(text).filter(isObj);
	const entrypoint = entries.map((e) => str(e.entrypoint)).find(Boolean);
	if (!opts.includeSdk && entrypoint?.startsWith("sdk")) return { skip: `agent-sdk mirror (${entrypoint})` };

	const turns: Turn[] = [];
	const toolNames = new Map<string, string>();
	let sessionId: string | null = null;
	let cwd: string | null = null;
	let title: string | null = null;
	let startedAt: string | null = null;
	let current: Turn | null = null;
	let currentMsgId: string | null = null;

	for (const e of entries) {
		sessionId ??= str(e.sessionId);
		cwd ??= str(e.cwd);
		if (e.type === "ai-title") title = str(e.aiTitle) ?? title;
		if (e.type === "summary") title ??= str(e.summary);
		if (e.isSidechain === true) continue;
		const ts = isoFrom(e.timestamp);
		const m = e.message;
		if (!isObj(m)) continue;
		if (e.type === "user") {
			startedAt ??= ts;
			currentMsgId = null;
			const bs = blocks(m.content);
			for (const b of bs.filter((b) => b.type === "tool_result")) {
				const id = String(b.tool_use_id ?? "");
				turns.push({
					uid: `${String(e.uuid ?? turns.length)}:${id}`,
					role: "tool",
					ts,
					text: resultText(b.content),
					toolCallId: id,
					toolName: toolNames.get(id) ?? null,
					isError: b.is_error === true,
				});
			}
			const t = bs
				.filter((b) => b.type === "text")
				.map((b) => String(b.text ?? ""))
				.join("\n");
			if (!t && bs.some((b) => b.type === "tool_result")) continue;
			const interruption = t.startsWith("[Request interrupted by user");
			if (interruption && turns.length) {
				const last = turns.findLast((x) => x.role === "assistant");
				if (last) last.interruption = true;
				continue;
			}
			turns.push({
				uid: String(e.uuid ?? turns.length),
				role: "user",
				ts,
				text: t,
				injected: e.isMeta === true || INJECTED_PREFIXES.some((p) => t.trimStart().startsWith(p)),
			});
		} else if (e.type === "assistant") {
			startedAt ??= ts;
			const msgId = str(m.id);
			if (!current || !msgId || msgId !== currentMsgId) {
				const u = isObj(m.usage) ? m.usage : {};
				const synthetic = m.model === "<synthetic>";
				current = {
					uid: String(e.uuid ?? turns.length),
					role: "assistant",
					ts,
					model: synthetic ? null : str(m.model),
					provider: "anthropic",
					thinking: str(e.effort),
					text: "",
					toolCalls: [],
					stopReason: e.isApiErrorMessage === true ? "error" : str(m.stop_reason),
					usage: {
						...emptyUsage(),
						input: num(u.input_tokens),
						output: num(u.output_tokens),
						cacheRead: num(u.cache_read_input_tokens),
						cacheWrite: num(u.cache_creation_input_tokens),
					},
				};
				currentMsgId = msgId;
				turns.push(current);
			}
			current.ts = ts ?? current.ts;
			if (str(m.stop_reason)) current.stopReason = str(m.stop_reason);
			for (const b of blocks(m.content)) {
				if (b.type === "text") current.text += (current.text ? "\n" : "") + String(b.text ?? "");
				else if (b.type === "tool_use") {
					const id = String(b.id ?? "");
					toolNames.set(id, String(b.name ?? "?"));
					current.toolCalls!.push({ id, name: String(b.name ?? "?"), args: b.input ?? null });
				}
			}
		}
	}
	if (!sessionId && turns.length === 0) return { skip: "no conversation entries" };
	return {
		session: {
			id: `claude:${sessionId ?? path}`,
			source: "claude",
			path,
			cwd,
			title,
			startedAt,
			turns,
		},
	};
}

// OmO and Pi share Pi's session format (version 3): a JSONL tree of entries linked by
// parentId, where only the branch ending at the last entry is the conversation the user
// kept; earlier branches were abandoned by /tree navigation or forks.
import { emptyUsage, isObj, isoFrom, num, type Obj, type ParseResult, parseJsonLines, type Source, str, type Turn } from "../types.ts";

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!isObj(block)) continue;
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
		else if (block.type === "image") parts.push("[image]");
	}
	return parts.join("\n");
}

function activeBranch(entries: Obj[]): Obj[] {
	const byId = new Map<string, Obj>();
	for (const e of entries) if (typeof e.id === "string") byId.set(e.id, e);
	let leaf: Obj | undefined;
	for (let i = entries.length - 1; i >= 0; i--) {
		if (typeof entries[i].id === "string" && entries[i].type !== "session") {
			leaf = entries[i];
			break;
		}
	}
	if (!leaf || !entries.some((e) => "parentId" in e)) return entries;
	const chain: Obj[] = [];
	const seen = new Set<string>();
	for (let cur: Obj | undefined = leaf; cur && typeof cur.id === "string" && !seen.has(cur.id); ) {
		seen.add(cur.id);
		chain.push(cur);
		cur = typeof cur.parentId === "string" ? byId.get(cur.parentId) : undefined;
	}
	const keep = new Set(chain);
	return entries.filter((e) => keep.has(e) || typeof e.id !== "string" || e.type === "session");
}

export function parsePiSession(text: string, path: string, source: Source): ParseResult {
	const entries = parseJsonLines(text).filter(isObj);
	const header = entries.find((e) => e.type === "session");
	if (!header) return { skip: "no session header" };
	const turns: Turn[] = [];
	let title: string | null = null;
	let model: string | null = null;
	let provider: string | null = null;
	let thinking: string | null = null;

	for (const e of activeBranch(entries)) {
		const ts = isoFrom(e.timestamp);
		switch (e.type) {
			case "session_info":
				title = str(e.name) ?? title;
				break;
			case "model_change":
				model = str(e.modelId) ?? model;
				provider = str(e.provider) ?? provider;
				break;
			case "thinking_level_change":
				thinking = str(e.thinkingLevel) ?? thinking;
				break;
			case "message": {
				const m = e.message;
				if (!isObj(m)) break;
				const uid = String(e.id ?? turns.length);
				if (m.role === "user") {
					const t = textOf(m.content);
					// Orchestrator steers and tasks are relayed with this prefix, not typed.
					turns.push({ uid, role: "user", ts, text: t, injected: t.startsWith("[orchestrator] ") });
				} else if (m.role === "assistant") {
					const content = Array.isArray(m.content) ? m.content.filter(isObj) : [];
					const toolCalls = content
						.filter((b) => b.type === "toolCall")
						.map((b) => ({ id: String(b.id ?? ""), name: String(b.name ?? "?"), args: b.arguments ?? null }));
					let t = content
						.filter((b) => b.type === "text")
						.map((b) => String(b.text ?? ""))
						.join("\n");
					if (!t && typeof m.errorMessage === "string") t = `[error] ${m.errorMessage}`;
					const u = isObj(m.usage) ? m.usage : {};
					turns.push({
						uid,
						role: "assistant",
						ts,
						model: str(m.model) ?? model,
						provider: str(m.provider) ?? provider,
						thinking: str(m.thinkingLevel) ?? thinking,
						text: t,
						toolCalls,
						stopReason: str(m.stopReason),
						interruption: m.stopReason === "aborted",
						usage: {
							...emptyUsage(),
							input: num(u.input),
							output: num(u.output),
							cacheRead: num(u.cacheRead),
							cacheWrite: num(u.cacheWrite),
							cost: isObj(u.cost) ? num(u.cost.total) : 0,
						},
					});
				} else if (m.role === "toolResult") {
					const details = isObj(m.details) ? m.details : {};
					turns.push({
						uid,
						role: "tool",
						ts,
						text: textOf(m.content),
						toolName: str(m.toolName),
						toolCallId: str(m.toolCallId),
						isError: m.isError === true || details.isError === true,
					});
				}
				break;
			}
			default:
				break;
		}
	}
	return {
		session: {
			id: `${source}:${String(header.id ?? path)}`,
			source,
			path,
			cwd: str(header.cwd),
			title,
			startedAt: isoFrom(header.timestamp),
			turns,
		},
	};
}

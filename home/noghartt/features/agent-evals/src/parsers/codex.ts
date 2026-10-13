import { emptyUsage, isObj, isoFrom, num, type Obj, type ParseResult, parseJsonLines, str, type Turn } from "../types.ts";

// Codex rollouts come in two shapes: current files wrap every line as
// {timestamp, type, payload}; older ones put the response items at the top level
// after a bare {id, timestamp, instructions} header. Both are read here.
const INJECTED_PREFIXES = ["<environment_context>", "<user_instructions>", "# AGENTS.md instructions", "<turn_aborted>"];

function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter(isObj)
		.map((b) => (typeof b.text === "string" ? b.text : b.type === "input_image" ? "[image]" : ""))
		.filter(Boolean)
		.join("\n");
}

function outputOf(raw: unknown): { text: string; isError: boolean } {
	if (isObj(raw)) {
		return { text: contentText(raw.content) || String(raw.content ?? ""), isError: raw.success === false };
	}
	const s = typeof raw === "string" ? raw : JSON.stringify(raw ?? "");
	try {
		const o = JSON.parse(s);
		if (isObj(o) && typeof o.output === "string") {
			const code = isObj(o.metadata) ? o.metadata.exit_code : undefined;
			return { text: o.output, isError: typeof code === "number" && code !== 0 };
		}
	} catch {
		// Plain-text outputs (custom tools, newer shells) are not JSON.
	}
	const exit = /(?:^|\n)(?:Process exited with code|Exit code:?)\s*(\d+)/.exec(s);
	return { text: s, isError: exit ? exit[1] !== "0" : false };
}

function parseArgs(raw: unknown): unknown {
	if (typeof raw !== "string") return raw ?? null;
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
}

export function parseCodexSession(text: string, path: string): ParseResult {
	const lines = parseJsonLines(text).filter(isObj);
	const turns: Turn[] = [];
	const toolNames = new Map<string, string>();
	let id: string | null = null;
	let cwd: string | null = null;
	let startedAt: string | null = null;
	let model: string | null = null;
	let provider: string | null = "openai";
	let effort: string | null = null;
	let assistant: Turn | null = null;

	const openAssistant = (ts: string | null, uid: string): Turn => {
		if (!assistant) {
			assistant = { uid, role: "assistant", ts, model, provider, thinking: effort, text: "", toolCalls: [], usage: emptyUsage() };
			turns.push(assistant);
		}
		assistant.ts = ts ?? assistant.ts;
		return assistant;
	};

	lines.forEach((line, index) => {
		const wrapped = typeof line.type === "string" && "payload" in line;
		const ts = isoFrom(line.timestamp);
		const kind = wrapped ? line.type : "response_item";
		const p: Obj = wrapped ? (isObj(line.payload) ? line.payload : {}) : line;
		const uid = String(index);
		if (!wrapped && index === 0 && "instructions" in line) {
			id = str(line.id);
			startedAt = isoFrom(line.timestamp);
			return;
		}
		if (kind === "session_meta") {
			id = str(p.id) ?? id;
			cwd = str(p.cwd) ?? cwd;
			startedAt = isoFrom(p.timestamp) ?? ts ?? startedAt;
			provider = str(p.model_provider) ?? provider;
			return;
		}
		if (kind === "turn_context") {
			model = str(p.model) ?? model;
			effort = str(p.effort) ?? str(isObj(p.reasoning) ? p.reasoning.effort : null) ?? effort;
			cwd ??= str(p.cwd);
			return;
		}
		if (kind === "event_msg") {
			if (p.type === "token_count" && isObj(p.info) && isObj(p.info.last_token_usage)) {
				const u = p.info.last_token_usage;
				const target = assistant ?? turns.findLast((t) => t.role === "assistant");
				if (target?.usage) {
					const cached = num(u.cached_input_tokens);
					target.usage.input += Math.max(0, num(u.input_tokens) - cached);
					target.usage.cacheRead += cached;
					target.usage.output += num(u.output_tokens);
				}
			} else if (p.type === "turn_aborted") {
				const last = turns.findLast((t) => t.role === "assistant");
				if (last) last.interruption = true;
			}
			return;
		}
		if (kind !== "response_item") return;
		switch (p.type) {
			case "message": {
				const t = contentText(p.content);
				if (p.role === "user") {
					assistant = null;
					turns.push({ uid, role: "user", ts, text: t, injected: INJECTED_PREFIXES.some((x) => t.trimStart().startsWith(x)) });
				} else if (p.role === "assistant") {
					const a = openAssistant(ts, uid);
					a.text += (a.text ? "\n" : "") + t;
				}
				break;
			}
			case "function_call":
			case "custom_tool_call":
			case "local_shell_call": {
				const callId = String(p.call_id ?? p.id ?? uid);
				const name = p.type === "local_shell_call" ? "shell" : String(p.name ?? "?");
				toolNames.set(callId, name);
				const args = p.type === "custom_tool_call" ? (p.input ?? null) : p.type === "local_shell_call" ? (p.action ?? null) : parseArgs(p.arguments);
				openAssistant(ts, uid).toolCalls!.push({ id: callId, name, args });
				break;
			}
			case "function_call_output":
			case "custom_tool_call_output": {
				assistant = null;
				const callId = String(p.call_id ?? "");
				const out = outputOf(p.output);
				turns.push({ uid, role: "tool", ts, text: out.text, toolCallId: callId, toolName: toolNames.get(callId) ?? null, isError: out.isError });
				break;
			}
			default:
				break;
		}
	});
	if (!id && turns.length === 0) return { skip: "not a codex rollout" };
	return { session: { id: `codex:${id ?? path}`, source: "codex", path, cwd, title: null, startedAt, turns } };
}

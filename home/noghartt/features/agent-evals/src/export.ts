import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stateDir } from "./paths.ts";
import { redact, redactDeep, scrubHome } from "./redact.ts";

export type ExportFormat = "sft" | "preference";
export type Provider = "openai" | "anthropic";

export interface ExportOptions {
	format: ExportFormat;
	provider: Provider;
	out?: string;
	includeGoodSessions?: boolean;
	system?: "summarize" | "strip";
	maxToolChars?: number;
	maxExampleBytes?: number;
	maxTotalBytes?: number;
	limit?: number;
}

interface Msg {
	role: "user" | "assistant" | "tool";
	text: string;
	toolCalls?: { id: string; name: string; args: unknown }[];
	toolCallId?: string | null;
	isError?: boolean;
}

interface TurnRow {
	seq: number;
	uid: string;
	role: Msg["role"];
	text: string;
	tool_calls: string | null;
	tool_call_id: string | null;
	is_error: number;
	injected: number;
}

const clean = (s: string) => scrubHome(redact(s));
const toolId = (id: string | null | undefined, n: number) => (id ?? "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || `call_${n}`;
const toolName = (n: string) => n.replace(/^mcp__.*__/, "").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64) || "tool";

function loadTurns(db: Database, sessionId: string): TurnRow[] {
	return db
		.query("SELECT seq, uid, role, text, tool_calls, tool_call_id, is_error, injected FROM turns WHERE session_id = ? ORDER BY seq")
		.all(sessionId) as TurnRow[];
}

function toMsg(t: TurnRow, maxTool: number): Msg | null {
	if (t.role === "user" && t.injected && !t.text.startsWith("[orchestrator] ")) return null;
	const text = clean(t.role === "tool" && t.text.length > maxTool ? `${t.text.slice(0, maxTool)}\n[... truncated]` : t.text);
	let calls: Msg["toolCalls"];
	if (t.tool_calls) {
		try {
			calls = (JSON.parse(t.tool_calls) as Msg["toolCalls"])!.map((c) => ({ ...c, args: redactDeep(c.args) }));
		} catch {
			calls = [];
		}
	}
	return { role: t.role, text, toolCalls: calls, toolCallId: t.tool_call_id, isError: t.is_error === 1 };
}

/** Exchanges start at user messages; trimming drops whole exchanges so tool calls keep their results. */
function fitContext(msgs: Msg[], render: (m: Msg[]) => string, maxBytes: number): Msg[] | null {
	const starts = msgs.map((m, i) => (m.role === "user" ? i : -1)).filter((i) => i >= 0);
	for (const s of starts.length ? starts : [0]) {
		const slice = msgs.slice(s);
		if (Buffer.byteLength(render(slice)) <= maxBytes) return slice;
	}
	return null;
}

function systemText(opts: ExportOptions, harness: string): string | null {
	if (opts.system === "strip") return null;
	return `You are a ${harness} coding agent working in a user's software repository through tools (read, edit, write, shell). Follow the user's instructions, verify your work, and report results plainly.`;
}

function openaiMessages(msgs: Msg[], weightLast: boolean | "all"): unknown[] {
	let n = 0;
	return msgs.map((m, i) => {
		if (m.role === "tool") return { role: "tool", tool_call_id: toolId(m.toolCallId, n++), content: m.text || "(empty)" };
		if (m.role === "user") return { role: "user", content: m.text };
		const out: Record<string, unknown> = { role: "assistant", content: m.text || null };
		if (m.toolCalls?.length)
			out.tool_calls = m.toolCalls.map((c) => ({
				id: toolId(c.id, n++),
				type: "function",
				function: { name: toolName(c.name), arguments: typeof c.args === "string" ? c.args : JSON.stringify(c.args ?? {}) },
			}));
		if (weightLast !== false) out.weight = weightLast === "all" || i === msgs.length - 1 ? 1 : 0;
		return out;
	});
}

function anthropicMessages(msgs: Msg[]): { role: string; content: unknown[] }[] {
	const out: { role: string; content: unknown[] }[] = [];
	let n = 0;
	const push = (role: string, block: unknown) => {
		const last = out.at(-1);
		if (last && last.role === role) last.content.push(block);
		else out.push({ role, content: [block] });
	};
	for (const m of msgs) {
		if (m.role === "user") push("user", { type: "text", text: m.text || "(empty)" });
		else if (m.role === "tool") push("user", { type: "tool_result", tool_use_id: toolId(m.toolCallId, n++), content: m.text || "(empty)", is_error: m.isError || undefined });
		else {
			if (m.text) push("assistant", { type: "text", text: m.text });
			for (const c of m.toolCalls ?? []) push("assistant", { type: "tool_use", id: toolId(c.id, n++), name: toolName(c.name), input: typeof c.args === "object" && c.args ? c.args : { input: c.args } });
		}
	}
	return out;
}

function asText(m: Msg): string {
	const calls = (m.toolCalls ?? []).map((c) => `[tool call] ${toolName(c.name)}(${JSON.stringify(c.args ?? {}).slice(0, 2000)})`);
	return [m.text, ...calls].filter(Boolean).join("\n");
}

interface Candidate {
	sessionId: string;
	harness: string;
	targetSeq: number | "all";
	preferred?: string;
	why: string;
}

function candidates(db: Database, opts: ExportOptions): Candidate[] {
	const out: Candidate[] = [];
	const turnLabels = db
		.query(
			`SELECT l.target_id, l.rating, l.preferred, t.session_id, t.seq, s.source FROM labels l
       JOIN turns t ON l.target_id = t.session_id || '#' || t.uid
       JOIN sessions s ON s.id = t.session_id
       WHERE l.target_type = 'turn' AND t.role = 'assistant'`,
		)
		.all() as { rating: string | null; preferred: string | null; session_id: string; seq: number; source: string }[];
	for (const l of turnLabels) {
		if (opts.format === "sft" && l.rating === "good") out.push({ sessionId: l.session_id, harness: l.source, targetSeq: l.seq, why: "turn labelled good" });
		if (opts.format === "preference" && l.rating === "bad" && l.preferred?.trim())
			out.push({ sessionId: l.session_id, harness: l.source, targetSeq: l.seq, preferred: l.preferred, why: "bad turn with preferred alternative" });
	}
	if (opts.format === "sft" && opts.includeGoodSessions) {
		const good = db
			.query("SELECT s.id, s.source FROM labels l JOIN sessions s ON s.id = l.target_id WHERE l.target_type = 'session' AND l.rating = 'good'")
			.all() as { id: string; source: string }[];
		for (const s of good) out.push({ sessionId: s.id, harness: s.source, targetSeq: "all", why: "session labelled good" });
	}
	return out;
}

export interface ExportResult {
	dir: string;
	examples: number;
	skipped: Record<string, number>;
}

export function exportDataset(db: Database, opts: ExportOptions): ExportResult {
	const maxTool = opts.maxToolChars ?? 4000;
	const maxExample = opts.maxExampleBytes ?? 256_000;
	const maxTotal = opts.maxTotalBytes ?? 100_000_000;
	const lines: string[] = [];
	const skipped: Record<string, number> = {};
	const skip = (why: string) => (skipped[why] = (skipped[why] ?? 0) + 1);
	const sessions = new Set<string>();
	let total = 0;

	for (const c of candidates(db, opts)) {
		if (opts.limit && lines.length >= opts.limit) {
			skip("over --limit");
			continue;
		}
		const turns = loadTurns(db, c.sessionId);
		const upto = c.targetSeq === "all" ? turns : turns.filter((t) => t.seq <= c.targetSeq);
		const msgs = upto.map((t) => toMsg(t, maxTool)).filter((m): m is Msg => !!m);
		const sys = systemText(opts, c.harness);
		let line: string | null = null;
		if (opts.format === "sft") {
			if (msgs.at(-1)?.role !== "assistant" && c.targetSeq !== "all") {
				skip("target turn missing");
				continue;
			}
			const render = (m: Msg[]) =>
				opts.provider === "openai"
					? JSON.stringify({ messages: [...(sys ? [{ role: "system", content: sys }] : []), ...openaiMessages(m, c.targetSeq === "all" ? "all" : true)] })
					: JSON.stringify({ ...(sys ? { system: sys } : {}), messages: anthropicMessages(m) });
			const fit = fitContext(msgs, render, maxExample);
			if (!fit || !fit.some((m) => m.role === "assistant")) {
				skip("too large");
				continue;
			}
			line = render(fit);
		} else {
			const rejected = msgs.at(-1);
			if (!rejected || rejected.role !== "assistant") {
				skip("target turn missing");
				continue;
			}
			const prompt = msgs.slice(0, -1);
			const chosen = clean(c.preferred!);
			const render = (m: Msg[]) =>
				opts.provider === "openai"
					? JSON.stringify({
							input: { messages: [...(sys ? [{ role: "system", content: sys }] : []), ...openaiMessages(m, false)] },
							preferred_output: [{ role: "assistant", content: chosen }],
							non_preferred_output: [{ role: "assistant", content: asText(rejected) }],
						})
					: JSON.stringify({
							...(sys ? { system: sys } : {}),
							messages: anthropicMessages(m),
							chosen: [{ type: "text", text: chosen }],
							rejected: anthropicMessages([rejected]).flatMap((x) => x.content),
						});
			const fit = fitContext(prompt, render, maxExample);
			if (!fit || !fit.length) {
				skip(fit ? "no prompt context" : "too large");
				continue;
			}
			line = render(fit);
		}
		const bytes = Buffer.byteLength(line) + 1;
		if (total + bytes > maxTotal) {
			skip("over --max-total-bytes");
			continue;
		}
		total += bytes;
		lines.push(line);
		sessions.add(c.sessionId);
	}

	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const dir = opts.out ?? join(stateDir(), "exports", `${stamp}-${opts.format}-${opts.provider}`);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const data = lines.length ? `${lines.join("\n")}\n` : "";
	writeFileSync(join(dir, "data.jsonl"), data, { mode: 0o600 });
	const manifest = {
		v: 1,
		createdAt: new Date().toISOString(),
		format: opts.format,
		provider: opts.provider,
		shape:
			opts.provider === "openai"
				? opts.format === "sft"
					? "OpenAI chat fine-tuning (messages, tool_calls, per-message weight)"
					: "OpenAI preference fine-tuning (input, preferred_output, non_preferred_output)"
				: opts.format === "sft"
					? "Anthropic Messages API (system, messages with tool_use/tool_result)"
					: "Anthropic Messages API prompt with chosen/rejected assistant content",
		system: opts.system ?? "summarize",
		selection: opts.format === "sft" ? (opts.includeGoodSessions ? "turns and sessions labelled good" : "turns labelled good") : "turns labelled bad with a preferred alternative",
		unlabeledIncluded: false,
		redaction: "secrets redacted on ingest and again on export; home paths replaced with ~",
		limits: { maxToolChars: maxTool, maxExampleBytes: maxExample, maxTotalBytes: maxTotal, limit: opts.limit ?? null },
		counts: { examples: lines.length, sessions: sessions.size, skipped },
		files: [{ name: "data.jsonl", bytes: Buffer.byteLength(data), lines: lines.length, sha256: createHash("sha256").update(data).digest("hex") }],
	};
	writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
	return { dir, examples: lines.length, skipped };
}

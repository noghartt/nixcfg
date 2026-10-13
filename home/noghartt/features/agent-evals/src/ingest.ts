import type { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { nowIso } from "./db.ts";
import { ingestOutcomes } from "./outcomes.ts";
import { parseClaudeSession } from "./parsers/claude.ts";
import { parseCodexSession } from "./parsers/codex.ts";
import { parsePiSession } from "./parsers/pi.ts";
import { outcomesPath, type SourceRoots, sourceRoots } from "./paths.ts";
import { poolKeyFor } from "./pool.ts";
import { redact, redactDeep } from "./redact.ts";
import { deriveSignals } from "./signals.ts";
import type { ParsedSession, ParseResult, Source } from "./types.ts";

// Size caps keep the database proportional to what a reviewer can read; a 2 MB tool
// dump is never what a label or an export needs.
const LIMITS = { user: 64_000, assistant: 64_000, tool: 16_000, args: 16_000 };

export function clip(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max)}\n[... ${text.length - max} chars truncated]`;
}

function walk(dir: string, accept: (name: string) => boolean, out: string[] = []): string[] {
	let entries: import("node:fs").Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of entries) {
		const p = join(dir, e.name);
		if (e.isDirectory()) walk(p, accept, out);
		else if (e.isFile() && accept(e.name)) out.push(p);
	}
	return out;
}

export function parseFile(source: Source, path: string, text: string, opts: { includeSdk?: boolean } = {}): ParseResult {
	switch (source) {
		case "omo":
		case "pi":
			return parsePiSession(text, path, source);
		case "claude":
			return parseClaudeSession(text, path, opts);
		case "codex":
			return parseCodexSession(text, path);
	}
}

export function storeSession(db: Database, s: ParsedSession): void {
	const sig = deriveSignals(s.turns);
	const assistants = s.turns.filter((t) => t.role === "assistant");
	const counts = new Map<string, { n: number; provider: string | null; thinking: string | null }>();
	for (const t of assistants) {
		if (!t.model) continue;
		const c = counts.get(t.model) ?? { n: 0, provider: t.provider ?? null, thinking: t.thinking ?? null };
		c.n++;
		counts.set(t.model, c);
	}
	const main = [...counts.entries()].sort((a, b) => b[1].n - a[1].n)[0];
	const sum = (f: (u: NonNullable<(typeof assistants)[0]["usage"]>) => number) => assistants.reduce((a, t) => a + (t.usage ? f(t.usage) : 0), 0);
	const firstUser = s.turns.find((t) => t.role === "user" && !t.injected) ?? s.turns.find((t) => t.role === "user");
	const timestamps = s.turns.map((t) => t.ts).filter((x): x is string => !!x);

	db.query("DELETE FROM turns WHERE session_id = ?").run(s.id);
	db.query(
		`INSERT OR REPLACE INTO sessions (id, source, path, cwd, title, started_at, ended_at, models, main_model, main_provider, pool_key, thinking,
      first_user, n_user, n_assistant, n_tool_calls, n_tool_errors, n_corrections, n_interruptions, n_retries, n_edits,
      tokens_in, tokens_out, tokens_cache_read, tokens_cache_write, cost, duration_ms, active_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
	).run(
		s.id,
		s.source,
		s.path,
		s.cwd,
		s.title ? redact(s.title) : null,
		s.startedAt ?? timestamps[0] ?? null,
		timestamps.at(-1) ?? null,
		JSON.stringify([...counts.keys()]),
		main?.[0] ?? null,
		main?.[1].provider ?? null,
		main ? (poolKeyFor(main[1].provider, main[0]) ?? main[0]) : null,
		main?.[1].thinking ?? null,
		firstUser ? clip(redact(firstUser.text), 4000) : null,
		sig.nUser,
		sig.nAssistant,
		sig.nToolCalls,
		sig.nToolErrors,
		sig.nCorrections,
		sig.nInterruptions,
		sig.nRetries,
		sig.nEdits,
		sum((u) => u.input),
		sum((u) => u.output),
		sum((u) => u.cacheRead),
		sum((u) => u.cacheWrite),
		sum((u) => u.cost),
		sig.durationMs,
		sig.activeMs,
	);
	const insert = db.query(`INSERT INTO turns (session_id, seq, uid, role, ts, model, provider, thinking, text, tool_calls, tool_name, tool_call_id,
      is_error, injected, is_correction, is_interruption, is_retry, stop_reason, tokens_in, tokens_out, tokens_cache_read, tokens_cache_write, duration_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
	s.turns.forEach((t, seq) => {
		const calls = t.toolCalls?.length ? clip(JSON.stringify(redactDeep(t.toolCalls)), LIMITS.args) : null;
		insert.run(
			s.id,
			seq,
			t.uid,
			t.role,
			t.ts,
			t.model ?? null,
			t.provider ?? null,
			t.thinking ?? null,
			clip(redact(t.text), LIMITS[t.role]),
			calls,
			t.toolName ?? null,
			t.toolCallId ?? null,
			t.isError ? 1 : 0,
			t.injected ? 1 : 0,
			t.isCorrection ? 1 : 0,
			t.interruption ? 1 : 0,
			t.isRetry ? 1 : 0,
			t.stopReason ?? null,
			t.usage?.input ?? null,
			t.usage?.output ?? null,
			t.usage?.cacheRead ?? null,
			t.usage?.cacheWrite ?? null,
			t.durationMs ?? null,
		);
	});
}

export interface IngestStats {
	scanned: number;
	updated: number;
	unchanged: number;
	skipped: Record<string, number>;
	errors: string[];
	outcomes: { added: number; bad: number };
}

export interface IngestOptions {
	roots?: SourceRoots;
	outcomes?: string;
	includeSdk?: boolean;
	force?: boolean;
	sources?: Source[];
}

/** Rereads only files whose size or mtime changed; labels key on stable entry ids, so they survive. */
export function ingest(db: Database, opts: IngestOptions = {}): IngestStats {
	const roots = opts.roots ?? sourceRoots();
	const stats: IngestStats = { scanned: 0, updated: 0, unchanged: 0, skipped: {}, errors: [], outcomes: { added: 0, bad: 0 } };
	const want = new Set<Source>(opts.sources ?? ["omo", "pi", "claude", "codex"]);
	const plan: [Source, string[]][] = [
		["omo", walk(roots.omo, (n) => n.endsWith(".jsonl"))],
		["pi", walk(roots.pi, (n) => n.endsWith(".jsonl"))],
		["claude", walk(roots.claude, (n) => n.endsWith(".jsonl"))],
		["codex", walk(roots.codex, (n) => n.endsWith(".jsonl"))],
	];
	const getFile = db.query("SELECT size, mtime_ms FROM files WHERE path = ?");
	const putFile = db.query(
		`INSERT INTO files(path, source, size, mtime_ms, session_id, skipped, ingested_at) VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(path) DO UPDATE SET size=excluded.size, mtime_ms=excluded.mtime_ms, session_id=excluded.session_id,
       skipped=excluded.skipped, ingested_at=excluded.ingested_at`,
	);
	for (const [source, files] of plan) {
		if (!want.has(source)) continue;
		for (const path of files) {
			stats.scanned++;
			try {
				const st = statSync(path);
				const mtime = Math.trunc(st.mtimeMs);
				const prev = getFile.get(path) as { size: number; mtime_ms: number } | null;
				if (!opts.force && prev && prev.size === st.size && prev.mtime_ms === mtime) {
					stats.unchanged++;
					continue;
				}
				const result = parseFile(source, path, readFileSync(path, "utf8"), opts);
				db.transaction(() => {
					if ("skip" in result) {
						stats.skipped[result.skip] = (stats.skipped[result.skip] ?? 0) + 1;
						putFile.run(path, source, st.size, mtime, null, result.skip, nowIso());
					} else {
						storeSession(db, result.session);
						putFile.run(path, source, st.size, mtime, result.session.id, null, nowIso());
						stats.updated++;
					}
				})();
			} catch (e) {
				stats.errors.push(`${path}: ${(e as Error).message}`);
			}
		}
	}
	const log = opts.outcomes ?? outcomesPath();
	if (existsSync(log)) stats.outcomes = ingestOutcomes(db, log);
	return stats;
}

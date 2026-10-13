import type { Database } from "bun:sqlite";
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { nowIso } from "./db.ts";
import { redact } from "./redact.ts";
import { isObj, num, type Obj, str } from "./types.ts";

export const VERDICTS = ["accepted", "rejected", "retry", "needs_leader", "failed", "done_ungated", "stopped"] as const;
/** Verdicts that carry a judgement; ungated and stopped attempts say nothing about quality. */
export const JUDGED = new Set(["accepted", "rejected", "retry", "needs_leader", "failed"]);

export interface Outcome {
	run: string;
	node: string;
	attempt: number;
	kind: string;
	ts: string;
	host: string | null;
	harness: string | null;
	task: string;
	criteria: string[];
	repo: string | null;
	placement: Obj | null;
	modelKey: string;
	modelRef: string | null;
	thinking: string | null;
	tier: number | null;
	pickNote: string | null;
	verdict: string;
	criteriaScores: unknown[];
	durationMs: number;
	workerSession: string | null;
	leaderSession: string | null;
}

/** Validates one C2 line; anything else (future versions, junk) returns null. */
export function parseOutcome(raw: unknown): Outcome | null {
	if (!isObj(raw) || raw.v !== 1) return null;
	const model = isObj(raw.model) ? raw.model : {};
	const run = str(raw.run);
	const node = str(raw.node);
	const verdict = str(raw.verdict);
	const key = str(model.key);
	if (!run || !node || !verdict || !key) return null;
	return {
		run,
		node,
		attempt: num(raw.attempt) || 1,
		kind: str(raw.kind) ?? "work",
		ts: str(raw.ts) ?? nowIso(),
		host: str(raw.host),
		harness: str(raw.harness),
		task: redact(str(raw.task) ?? ""),
		criteria: Array.isArray(raw.criteria) ? raw.criteria.map((c) => redact(String(c))) : [],
		repo: str(raw.repo),
		placement: isObj(raw.placement) ? raw.placement : null,
		modelKey: key,
		modelRef: str(model.ref),
		thinking: str(model.thinking),
		tier: typeof model.tier === "number" ? model.tier : null,
		pickNote: str(raw.pickNote) ? redact(String(raw.pickNote)) : null,
		verdict,
		criteriaScores: Array.isArray(raw.criteriaScores) ? raw.criteriaScores : [],
		durationMs: num(raw.durationMs),
		workerSession: str(raw.workerSession),
		leaderSession: str(raw.leaderSession),
	};
}

/**
 * The log is append-only (C2), so ingest resumes at the last complete line it read.
 * A shrunken file means it was rotated or rewritten, and is reread from the start.
 */
export function ingestOutcomes(db: Database, path: string): { added: number; bad: number } {
	if (!existsSync(path)) return { added: 0, bad: 0 };
	const st = statSync(path);
	const row = db.query("SELECT offset, size FROM files WHERE path = ?").get(path) as { offset: number; size: number } | null;
	let offset = row && row.size <= st.size ? row.offset : 0;
	if (offset >= st.size) return { added: 0, bad: 0 };
	const fd = openSync(path, "r");
	const buf = Buffer.alloc(st.size - offset);
	try {
		readSync(fd, buf, 0, buf.length, offset);
	} finally {
		closeSync(fd);
	}
	const text = buf.toString("utf8");
	const end = text.lastIndexOf("\n");
	if (end < 0) return { added: 0, bad: 0 };
	const insert = db.query(`INSERT OR IGNORE INTO outcomes
    (run, node, attempt, kind, ts, host, harness, task, criteria, repo, placement, model_key, model_ref, thinking, tier,
     pick_note, verdict, criteria_scores, duration_ms, worker_session, leader_session)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
	let added = 0;
	let bad = 0;
	db.transaction(() => {
		for (const line of text.slice(0, end).split("\n")) {
			if (!line.trim()) continue;
			let o: Outcome | null = null;
			try {
				o = parseOutcome(JSON.parse(line));
			} catch {
				o = null;
			}
			if (!o) {
				bad++;
				continue;
			}
			const r = insert.run(
				o.run,
				o.node,
				o.attempt,
				o.kind,
				o.ts,
				o.host,
				o.harness,
				o.task,
				JSON.stringify(o.criteria),
				o.repo,
				JSON.stringify(o.placement),
				o.modelKey,
				o.modelRef,
				o.thinking,
				o.tier,
				o.pickNote,
				o.verdict,
				JSON.stringify(o.criteriaScores),
				o.durationMs,
				o.workerSession,
				o.leaderSession,
			);
			added += r.changes;
		}
		offset += Buffer.byteLength(text.slice(0, end + 1), "utf8");
		db.query(
			`INSERT INTO files(path, source, size, mtime_ms, offset, ingested_at) VALUES (?, 'outcomes', ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET size=excluded.size, mtime_ms=excluded.mtime_ms, offset=excluded.offset, ingested_at=excluded.ingested_at`,
		).run(path, st.size, Math.trunc(st.mtimeMs), offset, nowIso());
	})();
	return { added, bad };
}

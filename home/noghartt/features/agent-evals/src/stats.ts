import type { Database } from "bun:sqlite";
import { JUDGED } from "./outcomes.ts";

export type Dim = "model" | "pool" | "class" | "pool-class";

export interface SessionRow {
	id: string;
	source: string;
	model: string | null;
	pool: string | null;
	cls: string;
	rating: string | null;
	started_at: string | null;
	n_user: number;
	n_tool_calls: number;
	n_tool_errors: number;
	n_corrections: number;
	n_interruptions: number;
	n_retries: number;
	tokens_in: number;
	tokens_out: number;
	tokens_cache_read: number;
	active_ms: number;
}

export interface OutcomeRow {
	run: string;
	node: string;
	attempt: number;
	kind: string;
	ts: string;
	model_key: string;
	model_ref: string | null;
	verdict: string;
	duration_ms: number;
	cls: string;
	node_rating: string | null;
}

const CLASS_OF = (type: string, idExpr: string) => `COALESCE(
  (SELECT task_class FROM labels WHERE target_type = '${type}' AND target_id = ${idExpr} AND task_class IS NOT NULL),
  (SELECT task_class FROM suggestions g WHERE g.target_type = '${type}' AND g.target_id = ${idExpr}
     ORDER BY CASE g.source WHEN 'llm' THEN 0 ELSE 1 END LIMIT 1),
  'unclassified')`;

export function loadSessions(db: Database, opts: { since?: string; source?: string } = {}): SessionRow[] {
	return db
		.query(
			`SELECT s.id, s.source,
         CASE WHEN s.main_model IS NULL THEN NULL WHEN s.main_provider IS NULL THEN s.main_model ELSE s.main_provider || '/' || s.main_model END AS model,
         s.pool_key AS pool, ${CLASS_OF("session", "s.id")} AS cls,
         (SELECT rating FROM labels WHERE target_type = 'session' AND target_id = s.id) AS rating,
         s.started_at, s.n_user, s.n_tool_calls, s.n_tool_errors, s.n_corrections, s.n_interruptions, s.n_retries,
         COALESCE(s.tokens_in, 0) AS tokens_in, COALESCE(s.tokens_out, 0) AS tokens_out,
         COALESCE(s.tokens_cache_read, 0) AS tokens_cache_read, COALESCE(s.active_ms, 0) AS active_ms
       FROM sessions s
       WHERE s.n_assistant > 0 AND (?1 IS NULL OR s.started_at >= ?1) AND (?2 IS NULL OR s.source = ?2)`,
		)
		.all(opts.since ?? null, opts.source ?? null) as SessionRow[];
}

export function loadOutcomes(db: Database, opts: { since?: string } = {}): OutcomeRow[] {
	return db
		.query(
			`SELECT o.run, o.node, o.attempt, o.kind, o.ts, o.model_key, o.model_ref, o.verdict, COALESCE(o.duration_ms, 0) AS duration_ms,
         ${CLASS_OF("node", "o.run || '/' || o.node")} AS cls,
         (SELECT rating FROM labels WHERE target_type = 'node' AND target_id = o.run || '/' || o.node) AS node_rating
       FROM outcomes o WHERE (?1 IS NULL OR o.ts >= ?1) ORDER BY o.ts`,
		)
		.all(opts.since ?? null) as OutcomeRow[];
}

function keyOf(dim: Dim, model: string | null, pool: string | null, cls: string): string {
	switch (dim) {
		case "model":
			return model ?? "unknown";
		case "pool":
			return pool ?? model ?? "unknown";
		case "class":
			return cls;
		case "pool-class":
			return `${pool ?? model ?? "unknown"} | ${cls}`;
	}
}

export interface Group {
	key: string;
	sessions: number;
	attempts: number;
	nodes: number;
	accepted: number;
	acceptRate: number | null;
	meanAttempts: number | null;
	correctionRate: number | null;
	toolErrorRate: number | null;
	interruptions: number;
	retries: number;
	good: number;
	bad: number;
	tokensIn: number;
	tokensOut: number;
	tokensCacheRead: number;
	meanSessionActiveMs: number | null;
	meanAttemptMs: number | null;
}

const ratio = (a: number, b: number) => (b > 0 ? a / b : null);

/**
 * Attempt-level acceptance: accepted / judged attempts (ungated and stopped attempts
 * judge nothing). meanAttempts counts, per node, the attempts made on this key, so an
 * escalation from sonnet to opus charges sonnet's tries to sonnet.
 */
export function aggregate(dim: Dim, sessions: SessionRow[], outcomes: OutcomeRow[]): Group[] {
	const groups = new Map<string, Group & { _users: number; _corr: number; _calls: number; _errors: number; _active: number[]; _durations: number[]; _perNode: Map<string, number> }>();
	const get = (key: string) => {
		let g = groups.get(key);
		if (!g) {
			g = {
				key,
				sessions: 0,
				attempts: 0,
				nodes: 0,
				accepted: 0,
				acceptRate: null,
				meanAttempts: null,
				correctionRate: null,
				toolErrorRate: null,
				interruptions: 0,
				retries: 0,
				good: 0,
				bad: 0,
				tokensIn: 0,
				tokensOut: 0,
				tokensCacheRead: 0,
				meanSessionActiveMs: null,
				meanAttemptMs: null,
				_users: 0,
				_corr: 0,
				_calls: 0,
				_errors: 0,
				_active: [],
				_durations: [],
				_perNode: new Map(),
			};
			groups.set(key, g);
		}
		return g;
	};
	for (const s of sessions) {
		const g = get(keyOf(dim, s.model, s.pool, s.cls));
		g.sessions++;
		g._users += s.n_user;
		g._calls += s.n_tool_calls;
		g._errors += s.n_tool_errors;
		g.interruptions += s.n_interruptions;
		g.retries += s.n_retries;
		g.tokensIn += s.tokens_in;
		g.tokensOut += s.tokens_out;
		g.tokensCacheRead += s.tokens_cache_read;
		g._active.push(s.active_ms);
		if (s.rating === "good") g.good++;
		if (s.rating === "bad") g.bad++;
		g._corr += s.n_corrections;
	}
	for (const o of outcomes) {
		const g = get(keyOf(dim, o.model_ref ?? o.model_key, o.model_key, o.cls));
		if (!JUDGED.has(o.verdict)) continue;
		g.attempts++;
		if (o.verdict === "accepted") g.accepted++;
		g._durations.push(o.duration_ms);
		const nodeKey = `${o.run}/${o.node}/${o.model_key}`;
		g._perNode.set(nodeKey, (g._perNode.get(nodeKey) ?? 0) + 1);
	}
	const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
	return [...groups.values()]
		.map((g) => {
			const perNode = [...g._perNode.values()];
			const { _users, _corr, _calls, _errors, _active, _durations, _perNode, ...rest } = g;
			return {
				...rest,
				nodes: _perNode.size,
				acceptRate: ratio(g.accepted, g.attempts),
				meanAttempts: mean(perNode),
				correctionRate: ratio(_corr, _users),
				toolErrorRate: ratio(_errors, _calls),
				meanSessionActiveMs: mean(_active),
				meanAttemptMs: mean(_durations),
			};
		})
		.sort((a, b) => b.sessions + b.attempts - (a.sessions + a.attempts) || a.key.localeCompare(b.key));
}

export function parseSince(v: string | undefined): string | undefined {
	if (!v) return undefined;
	const m = /^(\d+)([hdw])$/.exec(v);
	if (m) {
		const ms = Number(m[1]) * { h: 3600e3, d: 86400e3, w: 7 * 86400e3 }[m[2] as "h" | "d" | "w"];
		return new Date(Date.now() - ms).toISOString();
	}
	const t = Date.parse(v);
	if (Number.isNaN(t)) throw new Error(`--since: expected 12h, 30d, 2w or a date, got ${v}`);
	return new Date(t).toISOString();
}

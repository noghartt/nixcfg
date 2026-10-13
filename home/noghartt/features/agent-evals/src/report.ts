import type { Database } from "bun:sqlite";
import { aggregate, type Dim, type Group, loadOutcomes, loadSessions } from "./stats.ts";

export interface ReportOptions {
	by?: Dim[];
	since?: string;
	source?: string;
	format?: "md" | "json";
}

const pct = (v: number | null) => (v === null ? "-" : `${(v * 100).toFixed(0)}%`);
const fix = (v: number | null, d = 2) => (v === null ? "-" : v.toFixed(d));
const kTok = (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(0)}k` : String(v));
const dur = (ms: number | null) => (ms === null ? "-" : ms >= 3600e3 ? `${(ms / 3600e3).toFixed(1)}h` : ms >= 60e3 ? `${(ms / 60e3).toFixed(1)}m` : `${(ms / 1e3).toFixed(0)}s`);
const cell = (s: string) => s.replace(/\|/g, "\\|");

export function markdownTable(dim: Dim, groups: Group[]): string {
	const head = [
		dim,
		"sessions",
		"good/bad",
		"attempts",
		"nodes",
		"accept",
		"mean attempts",
		"corrections/user msg",
		"tool errors",
		"retries",
		"interrupts",
		"tokens in/out",
		"session active",
		"attempt time",
	];
	const rows = groups.map((g) => [
		cell(g.key),
		String(g.sessions),
		`${g.good}/${g.bad}`,
		String(g.attempts),
		String(g.nodes),
		pct(g.acceptRate),
		fix(g.meanAttempts),
		pct(g.correctionRate),
		pct(g.toolErrorRate),
		String(g.retries),
		String(g.interruptions),
		`${kTok(g.tokensIn + g.tokensCacheRead)}/${kTok(g.tokensOut)}`,
		dur(g.meanSessionActiveMs),
		dur(g.meanAttemptMs),
	]);
	return [`| ${head.join(" | ")} |`, `|${head.map(() => " --- ").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
}

export function report(db: Database, opts: ReportOptions = {}): string {
	const dims = opts.by?.length ? opts.by : (["model", "pool", "class"] as Dim[]);
	const sessions = loadSessions(db, { since: opts.since, source: opts.source });
	const outcomes = loadOutcomes(db, { since: opts.since });
	const tables = dims.map((dim) => ({ dim, groups: aggregate(dim, sessions, outcomes) }));
	if (opts.format === "json") {
		return JSON.stringify({ v: 1, generatedAt: new Date().toISOString(), since: opts.since ?? null, sessions: sessions.length, outcomes: outcomes.length, tables }, null, 2);
	}
	const out = [
		`# Agent evals report`,
		"",
		`${sessions.length} sessions, ${outcomes.length} outcome attempts${opts.since ? ` since ${opts.since}` : ""}.`,
		"Accept and mean attempts come from the orchestrator outcome log; corrections, tool errors and tokens from session transcripts.",
		"Token input counts cache reads. Classes are user labels first, then LLM, then heuristic suggestions.",
	];
	for (const t of tables) out.push("", `## By ${t.dim}`, "", t.groups.length ? markdownTable(t.dim, t.groups) : "_no data_");
	return out.join("\n");
}

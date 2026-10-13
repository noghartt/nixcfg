import type { Database } from "bun:sqlite";
import { spawnSync } from "node:child_process";
import { nodeTarget, putSuggestion, type TargetType } from "./labels.ts";
import { cheapestModel } from "./pool.ts";
import { redact } from "./redact.ts";
import { TASK_CLASSES, type TaskClass } from "./types.ts";

interface Rule {
	cls: TaskClass;
	re: RegExp;
	weight: number;
}

// Ordered weights: a "fix the failing nix build" is a bugfix in infra code, and the
// bugfix signal is the one that predicts how hard the task is.
const RULES: Rule[] = [
	{ cls: "review", re: /\b(review|audit|critique|look over|code review|revis[ae])\b/i, weight: 3 },
	{ cls: "research", re: /\b(research|investigate|explain|what is|what are|how does|how do|why does|why is|find out|look into|compare|pesquis|explique|como funciona|por que)\b/i, weight: 2 },
	{ cls: "bugfix", re: /\b(fix|bug|error|crash|fail(?:s|ing|ed|ure)?|broken|regression|doesn'?t work|not working|exception|corrig|conserta|erro|quebrad)\w*/i, weight: 3 },
	{ cls: "refactor", re: /\b(refactor|clean ?up|simplif|restructure|extract|deslop|modernize|reorganiz|dedupe)\w*/i, weight: 3 },
	{ cls: "test", re: /\b(add (?:a |unit |more )?tests?|write (?:a |unit )?tests?|test coverage|flaky|e2e|unit tests?)\b/i, weight: 3 },
	{ cls: "docs", re: /\b(readme|docs?|documentation|changelog|agents\.md|docstring|write[- ]?up)\b/i, weight: 2 },
	{ cls: "infra", re: /\b(nix|nixos|flake|home[- ]manager|docker|systemd|launchd|deploy|kubernetes|k8s|terraform|ci|github actions|pipeline|rebuild|sandbox|agentbox|firewall|tailscale)\b/i, weight: 2 },
	{ cls: "design", re: /\b(design|architecture|architect|propose|proposal|rfc|trade-?offs?|plan(?:ning)?|hyperplan)\b/i, weight: 2 },
	{ cls: "mechanical-edit", re: /\b(rename|bump|typo|reformat|format|move .* to|replace all|update (?:the )?version|sort|reword)\b/i, weight: 2 },
	{ cls: "feature", re: /\b(add|implement|build|create|support|introduce|new (?:feature|command|option)|enable|adiciona|implementa|cria)\w*/i, weight: 1 },
];

export interface Classification {
	cls: TaskClass;
	confidence: number;
	reason: string;
}

export function heuristicClass(text: string, hints: { nEdits?: number; kind?: string } = {}): Classification {
	if (hints.kind === "review") return { cls: "review", confidence: 0.95, reason: "review node" };
	const head = text.slice(0, 3000);
	const scores = new Map<TaskClass, number>();
	const hits: string[] = [];
	for (const r of RULES) {
		const m = head.match(r.re);
		if (!m) continue;
		scores.set(r.cls, (scores.get(r.cls) ?? 0) + r.weight);
		hits.push(`${r.cls}:${m[0].trim().slice(0, 24)}`);
	}
	// A session that edited nothing was not a feature or a fix, whatever it asked for.
	if (hints.nEdits === 0) {
		for (const c of ["feature", "bugfix", "refactor", "mechanical-edit", "test"] as TaskClass[]) if (scores.has(c)) scores.set(c, scores.get(c)! - 2);
		scores.set("research", (scores.get("research") ?? 0) + 1);
	}
	const ranked = [...scores.entries()].filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]);
	if (!ranked.length) return { cls: "other", confidence: 0.2, reason: "no keyword matched" };
	const [best, top] = ranked[0];
	const second = ranked[1]?.[1] ?? 0;
	const confidence = Math.min(0.8, 0.35 + 0.1 * (top - second) + 0.05 * top);
	return { cls: best, confidence: Number(confidence.toFixed(2)), reason: hits.join(", ") };
}

export interface Item {
	type: TargetType;
	id: string;
	text: string;
	nEdits?: number;
	kind?: string;
}

export function unlabeledItems(db: Database, opts: { all?: boolean } = {}): Item[] {
	const items: Item[] = [];
	const sessions = db
		.query(
			`SELECT s.id, s.first_user, s.n_edits FROM sessions s
       LEFT JOIN labels l ON l.target_type = 'session' AND l.target_id = s.id
       WHERE s.first_user IS NOT NULL AND (? OR l.task_class IS NULL)`,
		)
		.all(opts.all ? 1 : 0) as { id: string; first_user: string; n_edits: number }[];
	for (const s of sessions) items.push({ type: "session", id: s.id, text: s.first_user, nEdits: s.n_edits });
	const nodes = db
		.query(
			`SELECT o.run, o.node, MAX(o.kind) AS kind, MAX(o.task) AS task FROM outcomes o
       LEFT JOIN labels l ON l.target_type = 'node' AND l.target_id = o.run || '/' || o.node
       WHERE (? OR l.task_class IS NULL) GROUP BY o.run, o.node`,
		)
		.all(opts.all ? 1 : 0) as { run: string; node: string; kind: string; task: string }[];
	for (const n of nodes) items.push({ type: "node", id: nodeTarget(n.run, n.node), text: n.task ?? "", kind: n.kind });
	return items;
}

export function classifyHeuristic(db: Database, items: Item[]): number {
	db.transaction(() => {
		for (const it of items) {
			const c = heuristicClass(it.text, { nEdits: it.nEdits, kind: it.kind });
			putSuggestion(db, it.type, it.id, { source: "heuristic", task_class: c.cls, confidence: c.confidence, reason: c.reason, model: null });
		}
	})();
	return items.length;
}

export function buildPrompt(batch: Item[]): string {
	const lines = batch.map((it, i) => `### ${i}\n${redact(it.text).slice(0, 1500).replace(/\n{3,}/g, "\n\n")}`);
	return [
		"Classify each coding-agent task below into exactly one task class.",
		`Classes: ${TASK_CLASSES.join(", ")}.`,
		"mechanical-edit = rote, fully specified edits; bugfix = make something broken work; feature = new behaviour;",
		"refactor = restructure without behaviour change; review = judge existing work; research = answer a question, no edits;",
		"infra = build, deploy, OS, CI, Nix configuration; design = architecture or planning; test = tests only; docs = prose only.",
		'Reply with ONLY a JSON array, one object per task, in order: [{"i":0,"class":"bugfix","confidence":0.8,"reason":"short"}].',
		"Tasks:",
		...lines,
	].join("\n");
}

export function parseLlmReply(reply: string, size: number): (Classification | null)[] {
	const out: (Classification | null)[] = Array.from({ length: size }, () => null);
	const start = reply.indexOf("[");
	const end = reply.lastIndexOf("]");
	if (start < 0 || end <= start) return out;
	let arr: unknown;
	try {
		arr = JSON.parse(reply.slice(start, end + 1));
	} catch {
		return out;
	}
	if (!Array.isArray(arr)) return out;
	arr.forEach((o, pos) => {
		if (typeof o !== "object" || o === null) return;
		const r = o as Record<string, unknown>;
		const i = typeof r.i === "number" ? r.i : pos;
		const cls = String(r.class ?? "") as TaskClass;
		if (i < 0 || i >= size || !TASK_CLASSES.includes(cls)) return;
		const conf = typeof r.confidence === "number" ? Math.max(0, Math.min(1, r.confidence)) : 0.5;
		out[i] = { cls, confidence: conf, reason: String(r.reason ?? "").slice(0, 200) };
	});
	return out;
}

export interface LlmOptions {
	harness: "omo" | "pi";
	model?: string;
	batch?: number;
	timeoutMs?: number;
	run?: (cmd: string, args: string[], timeoutMs: number) => { ok: boolean; stdout: string; stderr: string };
}

function runHarness(cmd: string, args: string[], timeoutMs: number) {
	const r = spawnSync(cmd, args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
	return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.error ? String(r.error) : (r.stderr ?? "") };
}

/** Print-mode pass with tools, skills and context files off: the model only reads task text. */
export function classifyLlm(db: Database, items: Item[], opts: LlmOptions): { done: number; failed: number; errors: string[] } {
	const model = opts.model ?? cheapestModel();
	const size = opts.batch ?? 20;
	const run = opts.run ?? runHarness;
	let done = 0;
	let failed = 0;
	const errors: string[] = [];
	for (let i = 0; i < items.length; i += size) {
		const batch = items.slice(i, i + size);
		const args = ["-p", "--no-session", "--no-tools", "--no-skills", "--no-context-files", "--no-prompt-templates", "--model", model, "--thinking", "off", buildPrompt(batch)];
		const r = run(opts.harness, args, opts.timeoutMs ?? 180_000);
		if (!r.ok) {
			failed += batch.length;
			errors.push(r.stderr.trim().split("\n").slice(-3).join(" | "));
			continue;
		}
		const parsed = parseLlmReply(r.stdout, batch.length);
		db.transaction(() => {
			parsed.forEach((c, j) => {
				if (!c) {
					failed++;
					return;
				}
				putSuggestion(db, batch[j].type, batch[j].id, { source: "llm", task_class: c.cls, confidence: c.confidence, reason: c.reason, model });
				done++;
			});
		})();
	}
	return { done, failed, errors };
}

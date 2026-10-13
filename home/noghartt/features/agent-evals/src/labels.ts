import type { Database } from "bun:sqlite";
import { nowIso } from "./db.ts";
import { redact } from "./redact.ts";

export type TargetType = "session" | "turn" | "node" | "replay";

export interface Label {
	target_type: TargetType;
	target_id: string;
	rating: string | null;
	task_class: string | null;
	notes: string | null;
	preferred: string | null;
	updated_at: string;
}

export const turnTarget = (sessionId: string, uid: string) => `${sessionId}#${uid}`;
export const nodeTarget = (run: string, node: string) => `${run}/${node}`;

export function getLabel(db: Database, type: TargetType, id: string): Label | null {
	return db.query("SELECT * FROM labels WHERE target_type = ? AND target_id = ?").get(type, id) as Label | null;
}

export function setLabel(db: Database, type: TargetType, id: string, patch: Partial<Pick<Label, "rating" | "task_class" | "notes" | "preferred">>): Label {
	const cur = getLabel(db, type, id);
	const next = {
		rating: patch.rating !== undefined ? patch.rating : (cur?.rating ?? null),
		task_class: patch.task_class !== undefined ? patch.task_class : (cur?.task_class ?? null),
		notes: patch.notes !== undefined ? (patch.notes ? redact(patch.notes) : null) : (cur?.notes ?? null),
		preferred: patch.preferred !== undefined ? (patch.preferred ? redact(patch.preferred) : null) : (cur?.preferred ?? null),
	};
	db.query(
		`INSERT INTO labels(target_type, target_id, rating, task_class, notes, preferred, updated_at) VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(target_type, target_id) DO UPDATE SET rating=excluded.rating, task_class=excluded.task_class,
       notes=excluded.notes, preferred=excluded.preferred, updated_at=excluded.updated_at`,
	).run(type, id, next.rating, next.task_class, next.notes, next.preferred, nowIso());
	return getLabel(db, type, id)!;
}

export interface Suggestion {
	source: string;
	task_class: string;
	confidence: number | null;
	reason: string | null;
	model: string | null;
}

export function putSuggestion(db: Database, type: TargetType, id: string, s: Suggestion): void {
	db.query(
		`INSERT OR REPLACE INTO suggestions(target_type, target_id, source, task_class, confidence, reason, model, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
	).run(type, id, s.source, s.task_class, s.confidence, s.reason, s.model, nowIso());
}

/** LLM suggestions outrank heuristics; both are only suggestions until the user accepts one. */
export function bestSuggestion(db: Database, type: TargetType, id: string): Suggestion | null {
	return db
		.query(
			`SELECT source, task_class, confidence, reason, model FROM suggestions WHERE target_type = ? AND target_id = ?
       ORDER BY CASE source WHEN 'llm' THEN 0 ELSE 1 END LIMIT 1`,
		)
		.get(type, id) as Suggestion | null;
}

/** The class reports and priors use: a user label first, then the best suggestion. */
export function effectiveClass(db: Database, type: TargetType, id: string): { cls: string; source: string } {
	const label = getLabel(db, type, id);
	if (label?.task_class) return { cls: label.task_class, source: "user" };
	const s = bestSuggestion(db, type, id);
	return s ? { cls: s.task_class, source: s.source } : { cls: "unclassified", source: "none" };
}

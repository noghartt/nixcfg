import type { Database } from "bun:sqlite";
import { chmodSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { JUDGED } from "./outcomes.ts";
import { ensureStateDir, priorsPath } from "./paths.ts";
import { loadOutcomes, loadSessions } from "./stats.ts";

export interface PriorEntry {
	key: string;
	taskClass: string;
	n: number;
	acceptRate: number;
	meanAttempts: number;
}

export interface Priors {
	v: 1;
	updatedAt: string;
	models: PriorEntry[];
}

interface Acc {
	n: number;
	accepted: number;
	perNode: Map<string, number>;
}

/**
 * C3 from two kinds of evidence. Outcome attempts count as judged (accepted or not);
 * rated sessions count as one attempt each (good = accepted, bad = not), so a model
 * used only interactively still gets a prior. A node or session rating by the user
 * overrides Jev's verdict, and a "*" row per key aggregates every class for callers
 * whose task class is unknown.
 */
export function computePriors(db: Database, opts: { since?: string; minN?: number } = {}): Priors {
	const accs = new Map<string, Acc>();
	const acc = (key: string, cls: string) => {
		const id = `${key}\u0000${cls}`;
		let a = accs.get(id);
		if (!a) accs.set(id, (a = { n: 0, accepted: 0, perNode: new Map() }));
		return a;
	};
	const add = (key: string, cls: string, accepted: boolean, nodeId: string) => {
		for (const c of [cls, "*"]) {
			const a = acc(key, c);
			a.n++;
			if (accepted) a.accepted++;
			a.perNode.set(nodeId, (a.perNode.get(nodeId) ?? 0) + 1);
		}
	};
	for (const o of loadOutcomes(db, { since: opts.since })) {
		if (!JUDGED.has(o.verdict)) continue;
		const accepted = o.node_rating === "good" ? true : o.node_rating === "bad" ? false : o.verdict === "accepted";
		add(o.model_key, o.cls, accepted, `node:${o.run}/${o.node}/${o.model_key}`);
	}
	for (const s of loadSessions(db, { since: opts.since })) {
		if (s.rating !== "good" && s.rating !== "bad") continue;
		const key = s.pool ?? s.model;
		if (!key) continue;
		add(key, s.cls, s.rating === "good", `session:${s.id}`);
	}
	const models: PriorEntry[] = [];
	for (const [id, a] of accs) {
		if (a.n < (opts.minN ?? 1)) continue;
		const [key, taskClass] = id.split("\u0000");
		const per = [...a.perNode.values()];
		models.push({
			key,
			taskClass,
			n: a.n,
			acceptRate: Number((a.accepted / a.n).toFixed(4)),
			meanAttempts: Number((per.reduce((x, y) => x + y, 0) / per.length).toFixed(3)),
		});
	}
	models.sort((x, y) => x.key.localeCompare(y.key) || (x.taskClass === "*" ? -1 : y.taskClass === "*" ? 1 : x.taskClass.localeCompare(y.taskClass)));
	return { v: 1, updatedAt: new Date().toISOString(), models };
}

/** Written to a temp file and renamed, so T2 never reads half a file. */
export function writePriors(priors: Priors, path = priorsPath()): string {
	ensureStateDir(dirname(path));
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(priors, null, 2)}\n`, { mode: 0o600 });
	chmodSync(tmp, 0o600);
	renameSync(tmp, path);
	return path;
}

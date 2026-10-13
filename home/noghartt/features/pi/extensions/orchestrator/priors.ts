// Model priors (contract C3), written by agent-evals from the outcome log. Absent, unreadable,
// or stale priors leave the model decision as it was without them.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface PriorRow {
	key: string;
	taskClass: string;
	n: number;
	acceptRate: number;
	meanAttempts: number;
}

export interface Priors {
	v: 1;
	updatedAt: string;
	models: PriorRow[];
}

export const PRIORS_MAX_AGE_MS = 14 * 24 * 60 * 60_000;
const CLASSES_PER_KEY = 4;
const ALL_CLASSES = "*";

export function evalsDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
	return join(env.XDG_STATE_HOME || join(home, ".local", "state"), "agent-evals");
}

export function freshPriors(raw: unknown, now = Date.now()): Priors | undefined {
	const priors = raw as Partial<Priors> | null;
	if (!priors || priors.v !== 1 || !Array.isArray(priors.models) || typeof priors.updatedAt !== "string") return undefined;
	const updated = Date.parse(priors.updatedAt);
	if (Number.isNaN(updated) || now - updated > PRIORS_MAX_AGE_MS || updated - now > PRIORS_MAX_AGE_MS) return undefined;
	return priors as Priors;
}

export async function readPriors(path = join(evalsDir(), "priors.json"), now = Date.now()): Promise<Priors | undefined> {
	try {
		return freshPriors(JSON.parse(await readFile(path, "utf8")), now);
	} catch {
		return undefined;
	}
}

const percent = (rate: number) => `${Math.round(rate * 100)}%`;

// One line per pool key, e.g. "42 tasks, 71% accepted, 1.4 attempts; tests 90% (12), feature 60% (20)",
// small enough to ride along in every model decision.
export function summarizePriors(priors: Priors, keys: string[]): Record<string, string> | undefined {
	const summary: Record<string, string> = {};
	for (const key of keys) {
		const rows = priors.models.filter(
			(row) => row.key === key && Number.isFinite(row.n) && row.n > 0 && Number.isFinite(row.acceptRate) && Number.isFinite(row.meanAttempts),
		);
		// agent-evals adds a `*` row per key holding the all-class totals; it is the total when
		// present and never a class of its own, so summing it with the class rows would double count.
		const total = rows.find((row) => row.taskClass === ALL_CLASSES);
		const perClass = rows.filter((row) => row.taskClass !== ALL_CLASSES);
		const n = total ? total.n : perClass.reduce((sum, row) => sum + row.n, 0);
		if (n === 0) continue;
		const accept = total ? total.acceptRate : perClass.reduce((sum, row) => sum + row.acceptRate * row.n, 0) / n;
		const attempts = total ? total.meanAttempts : perClass.reduce((sum, row) => sum + row.meanAttempts * row.n, 0) / n;
		const classes = [...perClass]
			.sort((a, b) => b.n - a.n)
			.slice(0, CLASSES_PER_KEY)
			.map((row) => `${row.taskClass} ${percent(row.acceptRate)} (${row.n})`);
		summary[key] = `${n} tasks, ${percent(accept)} accepted, ${attempts.toFixed(1)} attempts${classes.length ? `; ${classes.join(", ")}` : ""}`;
	}
	return Object.keys(summary).length ? summary : undefined;
}

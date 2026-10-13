// Outcome log (contract C2): one line per settled node attempt, read by agent-evals.
import { appendFile, chmod, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { evalsDir } from "./priors.ts";

export type OutcomeVerdict = "accepted" | "rejected" | "retry" | "needs_leader" | "failed" | "done_ungated" | "stopped";

export interface OutcomeRecord {
	v: 1;
	ts: string;
	host: string;
	harness: "omo" | "pi";
	run: string;
	node: string;
	kind: "work" | "review";
	task: string;
	criteria: string[];
	repo: string | null;
	placement: { mode: "sandbox" | "worktree" | "shared"; box: string | null; net: string | null; size: string | null };
	model: { key: string; ref: string; thinking: string; tier: number };
	pickNote: string;
	attempt: number;
	verdict: OutcomeVerdict;
	criteriaScores: { criterion: string; pass: boolean; confidence: number }[];
	durationMs: number;
	workerSession: string | null;
	leaderSession: string | null;
}

export interface OutcomeInput {
	now: number;
	host: string;
	harness: "omo" | "pi";
	run: string;
	node: string;
	kind: "work" | "review";
	task: string;
	criteria: string[];
	repo?: string;
	placement: { mode: "sandbox" | "worktree" | "shared"; box?: string; net?: string; size?: string };
	model: { key: string; ref: string; thinking: string; tier: number };
	pickNote: string;
	attempt: number;
	verdict: OutcomeVerdict;
	// Jev's per-criterion probabilities; absent for review nodes and ungated results.
	scores?: { criterion: string; p: number }[];
	acceptThreshold: number;
	startedAt: number;
	workerSession?: string;
	leaderSession?: string;
}

export function outcomeRecord(input: OutcomeInput): OutcomeRecord {
	return {
		v: 1,
		ts: new Date(input.now).toISOString(),
		host: input.host,
		harness: input.harness,
		run: input.run,
		node: input.node,
		kind: input.kind,
		task: input.task,
		criteria: input.criteria,
		repo: input.repo ?? null,
		placement: {
			mode: input.placement.mode,
			box: input.placement.box ?? null,
			net: input.placement.net ?? null,
			size: input.placement.size ?? null,
		},
		model: input.model,
		pickNote: input.pickNote.trim(),
		attempt: input.attempt,
		verdict: input.verdict,
		criteriaScores: (input.scores ?? []).map((score) => ({
			criterion: score.criterion,
			pass: score.p >= input.acceptThreshold,
			confidence: score.p,
		})),
		durationMs: Math.max(0, input.now - input.startedAt),
		workerSession: input.workerSession ?? null,
		leaderSession: input.leaderSession ?? null,
	};
}

export const outcomesPath = (dir = evalsDir()): string => join(dir, "outcomes.jsonl");

export async function appendOutcome(record: OutcomeRecord, path = outcomesPath()): Promise<void> {
	const dir = dirname(path);
	await mkdir(dir, { recursive: true, mode: 0o700 });
	// mkdir's mode applies only to directories it creates; agent-evals may have made it first.
	await chmod(dir, 0o700);
	await appendFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

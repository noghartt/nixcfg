import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendOutcome, type OutcomeInput, outcomeRecord } from "./outcomes.ts";

const input: OutcomeInput = {
	now: Date.parse("2026-10-13T12:00:00Z"),
	host: "mellon",
	harness: "omo",
	run: "ab12cd34",
	node: "api",
	kind: "work",
	task: "Add the endpoint",
	criteria: ["tests pass", "docs updated"],
	repo: "/home/u/www/x",
	placement: { mode: "worktree" },
	model: { key: "sonnet", ref: "anthropic-subscription/claude-sonnet-5-5", thinking: "medium", tier: 1 },
	pickNote: " Default worker model. ",
	attempt: 2,
	verdict: "retry",
	startedAt: Date.parse("2026-10-13T11:58:00Z"),
	workerSession: "/home/u/.omo/agent/sessions/w.jsonl",
};

describe("outcomeRecord", () => {
	test("fills every C2 field", () => {
		const record = outcomeRecord(input);
		expect(Object.keys(record).sort()).toEqual(
			[
				"v", "ts", "host", "harness", "run", "node", "kind", "task", "criteria", "repo", "placement", "model",
				"pickNote", "attempt", "verdict", "criteriaScores", "durationMs", "workerSession", "leaderSession",
			].sort(),
		);
		expect(record.v).toBe(1);
		expect(record.ts).toBe("2026-10-13T12:00:00.000Z");
		expect(record.durationMs).toBe(120_000);
		expect(record.pickNote).toBe("Default worker model.");
		expect(record.leaderSession).toBeNull();
		expect(record.criteriaScores).toEqual([]);
	});
	test("uses null for an unknown repo and sessions", () => {
		const record = outcomeRecord({
			...input,
			repo: undefined,
			workerSession: undefined,
		});
		expect(record.repo).toBeNull();
		expect(record.workerSession).toBeNull();
	});
});

describe("appendOutcome", () => {
	test("appends one JSON line per call with private permissions", async () => {
		const root = await mkdtemp(join(tmpdir(), "orch-outcomes-"));
		const path = join(root, "agent-evals", "outcomes.jsonl");
		try {
			await appendOutcome(outcomeRecord(input), path);
			await appendOutcome(outcomeRecord({ ...input, attempt: 3, verdict: "accepted" }), path);
			const lines = (await readFile(path, "utf8")).trim().split("\n");
			expect(lines.map((line) => JSON.parse(line).verdict)).toEqual(["retry", "accepted"]);
			expect((await stat(path)).mode & 0o777).toBe(0o600);
			expect((await stat(join(root, "agent-evals"))).mode & 0o777).toBe(0o700);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evalsDir, freshPriors, type Priors, readPriors, summarizePriors } from "./priors.ts";

const now = Date.parse("2026-10-13T00:00:00Z");
const priors: Priors = {
	v: 1,
	updatedAt: "2026-10-10T00:00:00Z",
	models: [
		{ key: "sonnet", taskClass: "tests", n: 10, acceptRate: 0.9, meanAttempts: 1.1 },
		{ key: "sonnet", taskClass: "feature", n: 30, acceptRate: 0.5, meanAttempts: 1.9 },
		{ key: "opus", taskClass: "feature", n: 5, acceptRate: 0.8, meanAttempts: 1.2 },
		{ key: "retired", taskClass: "tests", n: 99, acceptRate: 1, meanAttempts: 1 },
		{ key: "opus", taskClass: "broken", n: 0, acceptRate: 0, meanAttempts: 0 },
	],
};

describe("freshPriors", () => {
	test("accepts a v1 file younger than 14 days", () => {
		expect(freshPriors(priors, now)).toBe(priors);
	});
	test("rejects stale, malformed, or other-version files", () => {
		expect(freshPriors({ ...priors, updatedAt: "2026-09-01T00:00:00Z" }, now)).toBeUndefined();
		expect(freshPriors({ ...priors, v: 2 }, now)).toBeUndefined();
		expect(freshPriors({ ...priors, models: "x" }, now)).toBeUndefined();
		expect(freshPriors({ ...priors, updatedAt: "not a date" }, now)).toBeUndefined();
		expect(freshPriors(null, now)).toBeUndefined();
	});
});

describe("summarizePriors", () => {
	test("summarizes pool keys only, weighting classes by n, biggest class first", () => {
		expect(summarizePriors(priors, ["sonnet", "opus", "fable"])).toEqual({
			sonnet: "40 tasks, 60% accepted, 1.7 attempts; feature 50% (30), tests 90% (10)",
			opus: "5 tasks, 80% accepted, 1.2 attempts; feature 80% (5)",
		});
	});
	test("takes a key's totals from its `*` row and never lists it as a class", () => {
		const withTotals: Priors = {
			...priors,
			models: [
				{ key: "sonnet", taskClass: "*", n: 40, acceptRate: 0.6, meanAttempts: 1.7 },
				...priors.models,
				{ key: "fable", taskClass: "*", n: 3, acceptRate: 1, meanAttempts: 1 },
			],
		};
		expect(summarizePriors(withTotals, ["sonnet", "fable"])).toEqual({
			sonnet: "40 tasks, 60% accepted, 1.7 attempts; feature 50% (30), tests 90% (10)",
			fable: "3 tasks, 100% accepted, 1.0 attempts",
		});
	});
	test("returns undefined when no pool key has data", () => {
		expect(summarizePriors(priors, ["fable"])).toBeUndefined();
	});
});

describe("readPriors", () => {
	test("reads a fresh file and treats a missing or broken one as absent", async () => {
		const dir = await mkdtemp(join(tmpdir(), "orch-priors-"));
		try {
			const path = join(dir, "priors.json");
			expect(await readPriors(path, now)).toBeUndefined();
			await writeFile(path, "{");
			expect(await readPriors(path, now)).toBeUndefined();
			await writeFile(path, JSON.stringify(priors));
			expect((await readPriors(path, now))?.models).toHaveLength(5);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
	test("follows XDG_STATE_HOME", () => {
		expect(evalsDir({ XDG_STATE_HOME: "/s" }, "/h")).toBe("/s/agent-evals");
		expect(evalsDir({}, "/h")).toBe("/h/.local/state/agent-evals");
	});
});

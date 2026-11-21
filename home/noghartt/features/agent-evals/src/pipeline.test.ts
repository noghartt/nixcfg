import { describe, expect, test } from "bun:test";
import { appendFileSync, copyFileSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyHeuristic, classifyLlm, heuristicClass, parseLlmReply, unlabeledItems } from "./classify.ts";
import { openDb } from "./db.ts";
import { ingest } from "./ingest.ts";
import { effectiveClass, setLabel, turnTarget } from "./labels.ts";
import { ingestOutcomes, parseOutcome } from "./outcomes.ts";
import { report } from "./report.ts";
import { FIXTURES, fixtureDb } from "./testutil.ts";

describe("ingest", () => {
	test("imports every supported format, skips mirrors, redacts, and is incremental", () => {
		const { db } = fixtureDb();
		const sessions = db.query("SELECT id, source, pool_key, n_corrections, n_tool_errors FROM sessions ORDER BY id").all() as Record<string, unknown>[];
		expect(sessions.map((s) => s.id)).toEqual(["claude:claude-sess-1", "codex:codex-legacy-1", "codex:codex-sess-1", "omo:omo-sess-1"]);
		expect(sessions.find((s) => s.id === "omo:omo-sess-1")?.pool_key).toBe("sonnet");
		expect(sessions.find((s) => s.id === "codex:codex-sess-1")?.pool_key).toBe("sonnet");
		expect(sessions.find((s) => s.id === "claude:claude-sess-1")?.pool_key).toBe("opus");
		const skipped = db.query("SELECT skipped FROM files WHERE skipped IS NOT NULL").all() as { skipped: string }[];
		expect(skipped.map((s) => s.skipped)).toEqual(["agent-sdk mirror (sdk-ts)"]);

		const all = JSON.stringify(db.query("SELECT text, tool_calls FROM turns").all()) + JSON.stringify(db.query("SELECT first_user FROM sessions").all());
		expect(all).not.toContain("sk-ant-api03-ABCDEF");
		expect(all).not.toContain("ghp_abcdefghij");
		expect(all).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
		expect(all).toContain("[REDACTED:anthropic-key]");

		const again = ingest(db, {
			roots: { omo: join(FIXTURES, "omo"), pi: join(FIXTURES, "pi-none"), claude: join(FIXTURES, "claude"), codex: join(FIXTURES, "codex") },
			outcomes: join(FIXTURES, "outcomes.jsonl"),
		});
		expect(again.updated).toBe(0);
		expect(again.unchanged).toBe(5);
		expect(again.outcomes.added).toBe(0);
	});

	test("labels survive a re-ingest of a changed file", () => {
		const { db, dir } = fixtureDb();
		const omoDir = join(dir, "omo", "p");
		const src = join(FIXTURES, "omo", "--tmp-proj--", "2026-10-01T10-00-00-000Z_omo-sess-1.jsonl");
		require("node:fs").mkdirSync(omoDir, { recursive: true });
		const copy = join(omoDir, "s.jsonl");
		copyFileSync(src, copy);
		const roots = { omo: join(dir, "omo"), pi: join(dir, "none"), claude: join(dir, "none"), codex: join(dir, "none") };
		ingest(db, { roots, outcomes: join(dir, "none.jsonl") });
		setLabel(db, "turn", turnTarget("omo:omo-sess-1", "e11"), { rating: "good" });
		appendFileSync(copy, '{"type":"session_info","id":"e16","parentId":"e15","timestamp":"2026-10-01T10:06:00.000Z","name":"Renamed"}\n');
		const st = ingest(db, { roots, outcomes: join(dir, "none.jsonl") });
		expect(st.updated).toBe(1);
		expect((db.query("SELECT title FROM sessions WHERE id = 'omo:omo-sess-1'").get() as { title: string }).title).toBe("Renamed");
		const joined = db.query("SELECT t.uid FROM labels l JOIN turns t ON l.target_id = t.session_id || '#' || t.uid").all();
		expect(joined).toEqual([{ uid: "e11" }]);
	});
});

describe("outcome log (C2)", () => {
	test("validates lines and resumes at the last complete line", () => {
		expect(parseOutcome({ v: 2, run: "r", node: "n", verdict: "accepted", model: { key: "k" } })).toBeNull();
		const dir = mkdtempSync(join(tmpdir(), "aeval-outcomes-"));
		const log = join(dir, "outcomes.jsonl");
		const lines = readFileSync(join(FIXTURES, "outcomes.jsonl"), "utf8").split("\n");
		require("node:fs").writeFileSync(log, `${lines.slice(0, 2).join("\n")}\n${lines[2].slice(0, 40)}`);
		const db = openDb(join(dir, "db.sqlite"));
		expect(ingestOutcomes(db, log)).toEqual({ added: 2, bad: 0 });
		require("node:fs").writeFileSync(log, `${lines.join("\n")}`);
		expect(ingestOutcomes(db, log)).toEqual({ added: 3, bad: 2 });
		expect(ingestOutcomes(db, log)).toEqual({ added: 0, bad: 0 });
		expect((db.query("SELECT COUNT(*) AS n FROM outcomes").get() as { n: number }).n).toBe(5);
	});
});

describe("classify", () => {
	test("heuristics pick the dominant class and respect review nodes and no-edit sessions", () => {
		expect(heuristicClass("Fix the failing nix build in flake.nix").cls).toBe("bugfix");
		expect(heuristicClass("Refactor the parser into smaller functions").cls).toBe("refactor");
		expect(heuristicClass("How does the module loader work? Explain", { nEdits: 0 }).cls).toBe("research");
		expect(heuristicClass("anything", { kind: "review" }).cls).toBe("review");
		expect(heuristicClass("Implement a new export command across modules").cls).toBe("feature");
		expect(heuristicClass("zzz").cls).toBe("other");
	});

	test("llm replies are parsed defensively and stored as suggestions below user labels", () => {
		expect(parseLlmReply('noise [{"i":1,"class":"infra","confidence":0.9,"reason":"nix"},{"i":0,"class":"nonsense"}] tail', 2)).toEqual([
			null,
			{ cls: "infra", confidence: 0.9, reason: "nix" },
		]);
		const { db } = fixtureDb();
		const items = unlabeledItems(db);
		expect(items.length).toBe(4 + 4);
		let prompt = "";
		const r = classifyLlm(db, items.slice(0, 2), {
			harness: "omo",
			run: (cmd, args) => {
				prompt = args.at(-1)!;
				expect(cmd).toBe("omo");
				expect(args).toContain("-p");
				expect(args).toContain("--no-tools");
				expect(args[args.indexOf("--model") + 1]).toBe("anthropic-subscription/claude-sonnet-5-5");
				return { ok: true, stdout: '[{"i":0,"class":"design","confidence":0.7,"reason":"x"},{"i":1,"class":"docs","confidence":0.6,"reason":"y"}]', stderr: "" };
			},
		});
		expect(r).toEqual({ done: 2, failed: 0, errors: [] });
		expect(prompt).not.toContain("sk-ant-api03-ABCDEF");
		expect(effectiveClass(db, items[0].type, items[0].id)).toEqual({ cls: "design", source: "llm" });
		setLabel(db, items[0].type, items[0].id, { task_class: "bugfix" });
		expect(effectiveClass(db, items[0].type, items[0].id)).toEqual({ cls: "bugfix", source: "user" });
		expect(unlabeledItems(db).length).toBe(7);
	});
});

describe("report", () => {
	test("report aggregates per model, pool and class in markdown and json", () => {
		const { db } = fixtureDb();
		classifyHeuristic(db, unlabeledItems(db));
		const md = report(db);
		expect(md).toContain("## By model");
		expect(md).toContain("## By pool");
		expect(md).toContain("## By class");
		const json = JSON.parse(report(db, { format: "json", by: ["pool"] }));
		const sonnet = json.tables[0].groups.find((g: { key: string }) => g.key === "sonnet");
		expect(sonnet).toMatchObject({ sessions: 2, attempts: 2, accepted: 1, acceptRate: 0.5, meanAttempts: 2 });
		expect(sonnet.correctionRate).toBeCloseTo(2 / 4);
		expect(sonnet.toolErrorRate).toBeCloseTo(2 / 6);
	});
});

import { describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { exportDataset } from "./export.ts";
import { setLabel, turnTarget } from "./labels.ts";
import { fixtureDb } from "./testutil.ts";

const lines = (dir: string) =>
	readFileSync(join(dir, "data.jsonl"), "utf8")
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));

describe("export", () => {
	test("never exports unlabeled data", () => {
		const { db, dir } = fixtureDb();
		for (const format of ["sft", "preference"] as const) {
			const r = exportDataset(db, { format, provider: "openai", out: join(dir, `none-${format}`), includeGoodSessions: true });
			expect(r.examples).toBe(0);
			const manifest = JSON.parse(readFileSync(join(r.dir, "manifest.json"), "utf8"));
			expect(manifest.unlabeledIncluded).toBe(false);
			expect(manifest.files[0].lines).toBe(0);
		}
	});

	test("openai sft: tool calls paired with results, weight on the labelled turn, secrets and home paths scrubbed", () => {
		const { db, dir } = fixtureDb();
		setLabel(db, "turn", turnTarget("omo:omo-sess-1", "e11"), { rating: "good" });
		const r = exportDataset(db, { format: "sft", provider: "openai", out: join(dir, "sft-openai") });
		expect(r.examples).toBe(1);
		const [ex] = lines(r.dir);
		const msgs = ex.messages as Record<string, unknown>[];
		expect(msgs[0].role).toBe("system");
		expect(msgs[1]).toMatchObject({ role: "user" });
		expect(msgs.at(-1)).toMatchObject({ role: "assistant", content: "Fixed: the build passes now.", weight: 1 });
		const callIds = msgs.flatMap((m) => ((m.tool_calls as { id: string }[]) ?? []).map((c) => c.id));
		const resultIds = msgs.filter((m) => m.role === "tool").map((m) => m.tool_call_id);
		expect(resultIds).toEqual(callIds);
		expect(msgs.filter((m) => m.role === "assistant" && m !== msgs.at(-1)).every((m) => m.weight === 0)).toBe(true);
		const raw = readFileSync(join(r.dir, "data.jsonl"), "utf8");
		expect(raw).not.toContain("sk-ant-api03-ABCDEF");
		expect(raw).not.toContain("ghp_abcdefghij");
		expect(raw).not.toContain("/home/someone");
		expect(raw).not.toContain("ABANDONED");
		expect(raw).not.toContain("environment_context");
		const manifest = JSON.parse(readFileSync(join(r.dir, "manifest.json"), "utf8"));
		expect(manifest).toMatchObject({ format: "sft", provider: "openai", counts: { examples: 1, sessions: 1 } });
		expect(manifest.files[0].sha256).toMatch(/^[0-9a-f]{64}$/);
		expect(statSync(join(r.dir, "data.jsonl")).mode & 0o777).toBe(0o600);
	});

	test("anthropic sft alternates roles and starts with a user message", () => {
		const { db, dir } = fixtureDb();
		setLabel(db, "session", "codex:codex-sess-1", { rating: "good" });
		const r = exportDataset(db, { format: "sft", provider: "anthropic", out: join(dir, "sft-anthropic"), includeGoodSessions: true, system: "strip" });
		expect(r.examples).toBe(1);
		const [ex] = lines(r.dir);
		expect(ex.system).toBeUndefined();
		const roles = (ex.messages as { role: string }[]).map((m) => m.role);
		expect(roles[0]).toBe("user");
		for (let i = 1; i < roles.length; i++) expect(roles[i]).not.toBe(roles[i - 1]);
		const blocks = (ex.messages as { content: { type: string }[] }[]).flatMap((m) => m.content.map((b) => b.type));
		expect(blocks).toContain("tool_use");
		expect(blocks).toContain("tool_result");
	});

	test("preference pairs need a bad turn with a preferred alternative", () => {
		const { db, dir } = fixtureDb();
		setLabel(db, "turn", turnTarget("claude:claude-sess-1", "c5"), { rating: "bad" });
		let r = exportDataset(db, { format: "preference", provider: "openai", out: join(dir, "pref-0") });
		expect(r.examples).toBe(0);
		setLabel(db, "turn", turnTarget("claude:claude-sess-1", "c5"), { preferred: "Read loader.ts first, then explain resolve() and cache()." });
		r = exportDataset(db, { format: "preference", provider: "openai", out: join(dir, "pref-openai") });
		const [o] = lines(r.dir);
		expect(o.input.messages.at(-1).role).toBe("tool");
		expect(o.preferred_output).toEqual([{ role: "assistant", content: "Read loader.ts first, then explain resolve() and cache()." }]);
		expect(o.non_preferred_output[0].content).toContain("The loader resolves modules lazily");
		expect(JSON.stringify(o)).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
		r = exportDataset(db, { format: "preference", provider: "anthropic", out: join(dir, "pref-anthropic") });
		const [a] = lines(r.dir);
		expect(a.messages.at(-1).role).toBe("user");
		expect(a.chosen[0].type).toBe("text");
		expect(a.rejected[0].text).toContain("The loader resolves modules lazily");
	});

	test("size limits skip oversized examples and are recorded", () => {
		const { db, dir } = fixtureDb();
		setLabel(db, "turn", turnTarget("omo:omo-sess-1", "e11"), { rating: "good" });
		const r = exportDataset(db, { format: "sft", provider: "openai", out: join(dir, "tiny"), maxExampleBytes: 100 });
		expect(r.examples).toBe(0);
		expect(r.skipped).toEqual({ "too large": 1 });
	});
});

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deriveSignals } from "../signals.ts";
import type { ParsedSession, ParseResult } from "../types.ts";
import { parseClaudeSession } from "./claude.ts";
import { parseCodexSession } from "./codex.ts";
import { parsePiSession } from "./pi.ts";

const FIX = join(import.meta.dir, "..", "..", "fixtures");
const read = (p: string) => readFileSync(join(FIX, p), "utf8");
const ok = (r: ParseResult): ParsedSession => {
	if ("skip" in r) throw new Error(`skipped: ${r.skip}`);
	return r.session;
};

describe("omo/pi parser", () => {
	const s = ok(parsePiSession(read("omo/--tmp-proj--/2026-10-01T10-00-00-000Z_omo-sess-1.jsonl"), "x.jsonl", "omo"));

	test("reads header, title and the active branch only", () => {
		expect(s.id).toBe("omo:omo-sess-1");
		expect(s.cwd).toBe("/home/someone/proj");
		expect(s.title).toBe("Fix nix build");
		expect(s.turns.some((t) => t.text.includes("ABANDONED"))).toBe(false);
		expect(s.turns.map((t) => t.role).join(",")).toBe("user,assistant,tool,assistant,tool,assistant,tool,assistant,user,assistant");
	});

	test("captures model, provider, thinking, usage and tool errors", () => {
		const a = s.turns[1];
		expect(a.model).toBe("claude-sonnet-5-5");
		expect(a.provider).toBe("anthropic-subscription");
		expect(a.thinking).toBe("high");
		expect(a.usage).toEqual({ input: 10, output: 100, cacheRead: 1000, cacheWrite: 50, cost: 0.01 });
		expect(a.toolCalls?.[0].name).toBe("bash");
		expect(s.turns[2].isError).toBe(true);
		expect(s.turns.at(-1)?.interruption).toBe(true);
	});

	test("derives corrections, retries, interruptions, edits and durations", () => {
		const sig = deriveSignals(s.turns);
		expect(sig).toMatchObject({ nUser: 2, nAssistant: 5, nToolCalls: 3, nToolErrors: 1, nCorrections: 1, nInterruptions: 1, nRetries: 1, nEdits: 1 });
		expect(sig.durationMs).toBe(303_000);
		expect(s.turns[3].isRetry).toBe(true);
		expect(s.turns[8].isCorrection).toBe(true);
	});

	test("a file without a session header is skipped", () => {
		expect(parsePiSession('{"type":"message"}\n', "y", "pi")).toEqual({ skip: "no session header" });
	});
});

describe("claude parser", () => {
	test("merges blocks of one message, skips sidechains and marks meta and interruptions", () => {
		const s = ok(parseClaudeSession(read("claude/-tmp-proj/claude-cli-1.jsonl"), "c.jsonl"));
		expect(s.id).toBe("claude:claude-sess-1");
		expect(s.title).toBe("Module loader explanation");
		expect(s.turns.map((t) => t.role).join(",")).toBe("user,user,assistant,tool,assistant");
		expect(s.turns[1].injected).toBe(true);
		const a = s.turns[2];
		expect(a.model).toBe("claude-opus-5-5");
		expect(a.thinking).toBe("high");
		expect(a.toolCalls).toHaveLength(1);
		expect(a.usage?.cacheRead).toBe(5000);
		expect(s.turns[3].toolName).toBe("Read");
		expect(s.turns.some((t) => t.text.includes("SIDECHAIN"))).toBe(false);
		expect(s.turns[4].interruption).toBe(true);
	});

	test("agent-sdk mirrors are skipped unless asked for", () => {
		const text = read("claude/-tmp-proj/claude-sdk-mirror.jsonl");
		expect(parseClaudeSession(text, "m")).toEqual({ skip: "agent-sdk mirror (sdk-ts)" });
		expect(ok(parseClaudeSession(text, "m", { includeSdk: true })).turns).toHaveLength(2);
	});
});

describe("codex parser", () => {
	test("reads wrapped rollouts with tool outputs, token counts and aborts", () => {
		const s = ok(parseCodexSession(read("codex/2026/10/03/rollout-2026-10-03T08-00-00-codex-sess-1.jsonl"), "r.jsonl"));
		expect(s.id).toBe("codex:codex-sess-1");
		expect(s.turns[0].injected).toBe(true);
		const roles = s.turns.map((t) => t.role).join(",");
		expect(roles).toBe("user,user,assistant,tool,assistant,tool,assistant,tool,assistant,user,assistant");
		expect(s.turns[2]).toMatchObject({ model: "gpt-5.6-terra", thinking: "medium", provider: "openai" });
		expect(s.turns[2].usage).toMatchObject({ input: 1000, cacheRead: 2000, output: 150 });
		expect(s.turns[3].isError).toBe(true);
		expect(s.turns[5].isError).toBe(false);
		expect(s.turns[6].toolCalls?.[0].name).toBe("apply_patch");
		expect(s.turns.at(-1)?.interruption).toBe(true);
		expect(JSON.stringify(s)).not.toContain("SYSTEM PROMPT");
		const sig = deriveSignals(s.turns);
		expect(sig).toMatchObject({ nUser: 2, nCorrections: 1, nToolErrors: 1, nRetries: 1, nEdits: 1, nInterruptions: 1 });
	});

	test("reads legacy top-level rollouts", () => {
		const s = ok(parseCodexSession(read("codex/legacy/rollout-legacy.jsonl"), "l.jsonl"));
		expect(s.id).toBe("codex:codex-legacy-1");
		expect(s.turns.map((t) => t.role).join(",")).toBe("user,assistant,tool,assistant");
		expect(s.turns.at(-1)?.text).toBe("Added the flag.");
	});
});

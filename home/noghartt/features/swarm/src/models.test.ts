import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fallbackChoice, firstUsable, type ModelConfig, requestedChoice } from "./models.ts";

const config = JSON.parse(readFileSync(new URL("../config.json", import.meta.url), "utf8")) as ModelConfig;
const refs = [...config.leader.models, ...config.pool.flatMap((entry) => entry.models)];

describe("config.json", () => {
	test("the leader is Opus 5.5 at xhigh, subscription provider first", () => {
		expect(config.leader.models).toEqual(["anthropic-subscription/claude-opus-5-5", "anthropic/claude-opus-5-5"]);
		expect(config.leader.thinking).toBe("xhigh");
	});

	test("the pool has the orchestrator's tiers", () => {
		const tiers = Object.fromEntries(config.pool.map((entry) => [entry.key, entry.tier]));
		expect(tiers).toEqual({ sonnet: 1, opus: 2, fable: 3, "gpt-astra": 3 });
		const sonnet = config.pool.find((entry) => entry.key === "sonnet")!;
		const opus = config.pool.find((entry) => entry.key === "opus")!;
		expect(opus.thinking).toBe("high");
		expect(sonnet.models.some((ref) => ref.includes("gpt-5.6-terra"))).toBe(true);
		expect(opus.models.some((ref) => ref.includes("gpt-6-sol"))).toBe(true);
	});

	test("no Haiku, no GPT-5.6 Sol or Luna, and Claude goes through the subscription provider first", () => {
		expect(refs.filter((ref) => /haiku|gpt-5\.6-(sol|luna)/.test(ref))).toEqual([]);
		for (const entry of config.pool) {
			const claude = entry.models.filter((ref) => ref.includes("claude-"));
			if (claude.length) expect(claude[0].startsWith("anthropic-subscription/")).toBe(true);
			expect(claude.every((ref) => ref.startsWith("anthropic-subscription/") || ref.startsWith("anthropic/"))).toBe(true);
		}
	});

	test("the fallback member is a pool key", () => {
		expect(config.pool.map((entry) => entry.key)).toContain(config.fallbackMember);
	});
});

describe("model resolution", () => {
	test("the fallback member keeps the pool entry's whole chain and thinking", () => {
		const choice = fallbackChoice(config);
		const entry = config.pool.find((candidate) => candidate.key === config.fallbackMember)!;
		expect(choice.models).toEqual(entry.models);
		expect(choice.thinking).toBe(entry.thinking);
	});

	test("a pool key resolves to its chain, a model id to itself", () => {
		const opus = config.pool.find((entry) => entry.key === "opus")!;
		expect(requestedChoice(config, "opus").models).toEqual(opus.models);
		const raw = requestedChoice(config, "anthropic-subscription/claude-sonnet-5-5");
		expect(raw.models).toEqual(["anthropic-subscription/claude-sonnet-5-5"]);
		expect(raw.thinking).toBe(fallbackChoice(config).thinking);
	});

	test("an unknown fallback member is an error", () => {
		expect(() => fallbackChoice({ ...config, fallbackMember: "nope" })).toThrow("not a pool key");
	});

	test("the first model with credentials wins, in list order", () => {
		const have = new Set(["anthropic/claude-opus-5-5", "chatgpt-subscription/gpt-6-sol"]);
		const opus = config.pool.find((entry) => entry.key === "opus")!;
		expect(firstUsable(opus.models, (ref) => have.has(ref))).toBe("anthropic/claude-opus-5-5");
		expect(firstUsable(opus.models, (ref) => ref.startsWith("chatgpt-subscription/"))).toBe("chatgpt-subscription/gpt-6-sol");
		expect(firstUsable(opus.models, () => false)).toBeUndefined();
	});
});

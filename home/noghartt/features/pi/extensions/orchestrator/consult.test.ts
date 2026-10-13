import { describe, expect, test } from "bun:test";
import { pickConsultant } from "./consult.ts";
import { limitPressure, spill } from "./limits.ts";

const MODELS = [
	"anthropic-subscription/claude-fable-5-1",
	"anthropic/claude-fable-5-1",
	"chatgpt-subscription/gpt-6-astra",
	"openai-codex/gpt-6-astra",
];
const all = () => true;
const pressure = (claude?: number, chatgpt?: number) => (ref: string) => (ref.startsWith("anthropic") ? claude : chatgpt);

describe("pickConsultant", () => {
	test("prefers Fable while Claude has headroom or its limits are unknown", () => {
		expect(pickConsultant(MODELS, all, pressure(50, 10), 85)?.ref).toBe(MODELS[0]);
		expect(pickConsultant(MODELS, all, pressure(undefined, undefined), 85)?.ref).toBe(MODELS[0]);
	});
	test("moves to Astra when Claude's limits are hot and ChatGPT's are not", () => {
		const picked = pickConsultant(MODELS, all, pressure(92, 30), 85);
		expect(picked?.ref).toBe(MODELS[2]);
		expect(picked?.note).toContain("92%");
	});
	test("stays on Fable when both providers are hot", () => {
		expect(pickConsultant(MODELS, all, pressure(95, 90), 85)?.ref).toBe(MODELS[0]);
	});
	test("falls back to the Pi providers and to Astra by credentials", () => {
		const piOnly = (ref: string) => !ref.includes("subscription");
		expect(pickConsultant(MODELS, piOnly, pressure(), 85)?.ref).toBe("anthropic/claude-fable-5-1");
		const chatgptOnly = (ref: string) => ref.includes("gpt");
		expect(pickConsultant(MODELS, chatgptOnly, pressure(), 85)?.ref).toBe(MODELS[2]);
	});
	test("returns undefined when no model has credentials", () => {
		expect(pickConsultant(MODELS, () => false, pressure(), 85)).toBeUndefined();
	});
});

describe("spill", () => {
	test("needs another model to spill to", () => {
		expect(spill("anthropic/a", undefined, 85, () => 99)).toEqual({ ref: "anthropic/a" });
	});
});

describe("limitPressure", () => {
	test("reads the fullest window of a fresh cache and ignores a stale one", async () => {
		const path = `${process.env.TMPDIR ?? "/tmp"}/orch-limits-${process.pid}.json`;
		const now = 1_000_000_000;
		await Bun.write(
			path,
			JSON.stringify({ checkedAt: now, providers: [{ id: "claude", windows: [{ percent: 40 }, { percent: 71 }] }] }),
		);
		expect(limitPressure("anthropic-subscription/x", now, path)).toBe(71);
		expect(limitPressure("chatgpt-subscription/x", now, path)).toBeUndefined();
		expect(limitPressure("anthropic/x", now + 31 * 60_000, path)).toBeUndefined();
		await Bun.file(path).delete();
	});
});

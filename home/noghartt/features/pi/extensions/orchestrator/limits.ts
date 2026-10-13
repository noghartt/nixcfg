// Provider limit readings the statusline shares across processes (statusline/limits.ts).
// Never fetched here: a stale or missing cache means "unknown", which counts as headroom.
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LIMITS_CACHE = join(tmpdir(), "pi-statusline-limits.json");
const LIMITS_STALE_MS = 30 * 60_000;

export type Pressure = (ref: string) => number | undefined;

export const limitsId = (ref: string): "claude" | "chatgpt" =>
	ref.slice(0, Math.max(0, ref.indexOf("/"))).startsWith("anthropic") ? "claude" : "chatgpt";

// The fullest window of a provider's accounts, in percent; undefined when unknown or stale.
export function limitPressure(ref: string, now = Date.now(), path = LIMITS_CACHE): number | undefined {
	try {
		const cache = JSON.parse(readFileSync(path, "utf8")) as {
			checkedAt?: number;
			providers?: { id: string; windows?: { percent: number }[] }[];
		};
		if (!cache.checkedAt || now - cache.checkedAt > LIMITS_STALE_MS) return undefined;
		const windows = cache.providers?.find((provider) => provider.id === limitsId(ref))?.windows ?? [];
		return windows.length ? Math.max(...windows.map((window) => window.percent)) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Keeps `preferred` until its provider's limits reach `spillAt`, then moves to `other` (a model
 * of the other provider) if that one is still below it. Returns the hot reading when it spilled.
 */
export function spill(
	preferred: string,
	other: string | undefined,
	spillAt: number,
	pressure: Pressure,
): { ref: string; hot?: number } {
	const hot = pressure(preferred);
	if (!other || hot === undefined || hot < spillAt) return { ref: preferred };
	if ((pressure(other) ?? 0) >= spillAt) return { ref: preferred };
	return { ref: other, hot };
}

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isObj } from "./types.ts";

export interface PoolEntry {
	key: string;
	models: string[];
	thinking?: string;
	tier?: number;
}

// The orchestrator's pool config is the single source of pool keys; the package keeps
// the repo's relative layout so this path resolves from the store as well.
const DEFAULT_CONFIG = join(import.meta.dir, "..", "..", "pi", "extensions", "orchestrator", "config.json");

let cached: PoolEntry[] | null = null;

export function loadPool(path = process.env.AEVAL_POOL_CONFIG || DEFAULT_CONFIG): PoolEntry[] {
	if (cached) return cached;
	try {
		if (!existsSync(path)) return (cached = []);
		const raw = JSON.parse(readFileSync(path, "utf8"));
		const pool = isObj(raw) && Array.isArray(raw.pool) ? raw.pool : [];
		cached = pool.filter(isObj).map((p: Record<string, unknown>) => ({
			key: String(p.key),
			models: Array.isArray(p.models) ? p.models.map(String) : [],
			thinking: typeof p.thinking === "string" ? p.thinking : undefined,
			tier: typeof p.tier === "number" ? p.tier : undefined,
		}));
	} catch {
		cached = [];
	}
	return cached;
}

export function setPool(pool: PoolEntry[] | null): void {
	cached = pool;
}

export function poolKeyFor(provider: string | null | undefined, model: string | null | undefined, pool = loadPool()): string | null {
	if (!model) return null;
	const ref = provider ? `${provider}/${model}` : model;
	for (const p of pool) if (p.models.includes(ref)) return p.key;
	for (const p of pool) if (p.models.some((m) => m.split("/").pop() === model)) return p.key;
	return null;
}

/** The first model of the lowest tier: classify's default and the cheapest useful judge. */
export function cheapestModel(pool = loadPool()): string {
	const sorted = [...pool].sort((a, b) => (a.tier ?? 99) - (b.tier ?? 99));
	return sorted[0]?.models[0] ?? "anthropic-subscription/claude-sonnet-5-5";
}

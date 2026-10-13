import type { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db.ts";
import { ingest } from "./ingest.ts";
import { setPool } from "./pool.ts";

export const FIXTURES = join(import.meta.dir, "..", "fixtures");

export const TEST_POOL = [
	{ key: "sonnet", models: ["anthropic-subscription/claude-sonnet-5-5", "chatgpt-subscription/gpt-5.6-terra"], tier: 1 },
	{ key: "opus", models: ["anthropic-subscription/claude-opus-5-5"], tier: 2 },
	{ key: "fable", models: ["anthropic-subscription/claude-fable-5-1"], tier: 3 },
];

export function fixtureDb(): { db: Database; dir: string } {
	setPool(TEST_POOL);
	const dir = mkdtempSync(join(tmpdir(), "aeval-test-"));
	process.env.AEVAL_STATE_DIR = dir;
	const db = openDb(join(dir, "aeval.sqlite"));
	ingest(db, {
		roots: { omo: join(FIXTURES, "omo"), pi: join(FIXTURES, "pi-none"), claude: join(FIXTURES, "claude"), codex: join(FIXTURES, "codex") },
		outcomes: join(FIXTURES, "outcomes.jsonl"),
	});
	return { db, dir };
}

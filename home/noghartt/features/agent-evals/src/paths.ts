import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function home(): string {
	return process.env.HOME || homedir();
}

export function stateDir(): string {
	const base = process.env.XDG_STATE_HOME || join(home(), ".local", "state");
	return process.env.AEVAL_STATE_DIR || join(base, "agent-evals");
}

/** C2/C3 require a private directory: transcripts and labels can quote anything. */
export function ensureStateDir(dir = stateDir()): string {
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
	chmodSync(dir, 0o700);
	return dir;
}

export const dbPath = (dir = stateDir()) => join(dir, "aeval.sqlite");
export const outcomesPath = (dir = stateDir()) => join(dir, "outcomes.jsonl");
export const priorsPath = (dir = stateDir()) => join(dir, "priors.json");

export interface SourceRoots {
	omo: string;
	pi: string;
	claude: string;
	codex: string;
}

export function sourceRoots(): SourceRoots {
	const h = home();
	return {
		omo: process.env.AEVAL_OMO_SESSIONS || join(h, ".omo", "agent", "sessions"),
		pi: process.env.AEVAL_PI_SESSIONS || join(h, ".pi", "agent", "sessions"),
		claude: process.env.AEVAL_CLAUDE_PROJECTS || join(process.env.CLAUDE_CONFIG_DIR || join(h, ".claude"), "projects"),
		codex: process.env.AEVAL_CODEX_SESSIONS || join(process.env.CODEX_HOME || join(h, ".codex"), "sessions"),
	};
}

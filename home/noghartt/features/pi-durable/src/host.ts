import type { Harness } from "@earendil-works/pi-durable";
import type { AgentProfiles } from "./profiles.ts";

/** Fan-out bounds: the default number of subagents one `parallel` call runs at once, and the most it may ask for. */
export const DEFAULT_PARALLEL = 4;
export const MAX_PARALLEL = 8;
/** Tasks one `parallel` call takes at most. */
export const MAX_PARALLEL_TASKS = 16;

/**
 * What this process's extensions need beyond the tool API: the session they run in, the profiles, and the Harness for
 * the few things a tool cannot do through its own API (stopping a watcher another call started, reading sessions).
 * `harness` is set once the Harness is open, before any task runs.
 */
export interface Host {
	readonly sessionId: string;
	readonly sessionDir: string;
	readonly cwd: string;
	readonly profiles: AgentProfiles;
	harness: Harness | undefined;
}

export function requireHarness(host: Host): Harness {
	if (host.harness === undefined) throw new Error("The session is not open yet");
	return host.harness;
}

export function oneLine(text: string, max = 200): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

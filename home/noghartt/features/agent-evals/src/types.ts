export type Source = "omo" | "pi" | "claude" | "codex";
export type Role = "user" | "assistant" | "tool";

export interface ToolCall {
	id: string;
	name: string;
	args: unknown;
}

export interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export interface Turn {
	uid: string;
	role: Role;
	ts: string | null;
	model?: string | null;
	provider?: string | null;
	thinking?: string | null;
	text: string;
	toolCalls?: ToolCall[];
	toolName?: string | null;
	toolCallId?: string | null;
	isError?: boolean;
	injected?: boolean;
	interruption?: boolean;
	stopReason?: string | null;
	usage?: Usage;
	isCorrection?: boolean;
	isRetry?: boolean;
	durationMs?: number | null;
}

export interface ParsedSession {
	id: string;
	source: Source;
	path: string;
	cwd: string | null;
	title: string | null;
	startedAt: string | null;
	turns: Turn[];
}

export type ParseResult = { session: ParsedSession } | { skip: string };

export const TASK_CLASSES = [
	"mechanical-edit",
	"bugfix",
	"feature",
	"refactor",
	"review",
	"research",
	"infra",
	"design",
	"test",
	"docs",
	"other",
] as const;
export type TaskClass = (typeof TASK_CLASSES)[number];

export const RATINGS = ["good", "bad", "neutral"] as const;
export type Rating = (typeof RATINGS)[number];

export const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });

export function num(v: unknown): number {
	return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

export function str(v: unknown): string | null {
	return typeof v === "string" && v.length > 0 ? v : null;
}

export function isoFrom(v: unknown): string | null {
	if (typeof v === "string" && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
	if (typeof v === "number" && Number.isFinite(v)) return new Date(v).toISOString();
	return null;
}

export function parseJsonLines(text: string): unknown[] {
	const out: unknown[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line));
		} catch {
			// A torn last line from a live writer is normal; the next ingest rereads it.
		}
	}
	return out;
}

export type Obj = Record<string, unknown>;
export const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

import type { Turn } from "./types.ts";

// Pushback phrasing in English and Portuguese (the user writes both). Anchored or
// phrase-level on purpose: a bare "no" mid-sentence is usually not a correction.
const CORRECTION =
	/^\s*(?:no|nope|nah|wrong|não|nao|errado)\b|\b(?:still (?:fail(?:s|ing)?|broken|not working|doesn'?t work|the same|wrong|erroring)|(?:doesn'?t|does not|didn'?t|did not) work|not working|that'?s (?:not|wrong)|this is wrong|not what i (?:asked|meant|wanted)|i (?:said|told you|asked you)|you (?:broke|missed|forgot|ignored)|revert (?:that|this|it)|undo (?:that|this|it)|try again|ainda (?:não|nao|falha|quebrad|dá erro|da erro)|continua (?:falhando|quebrad|com erro|dando erro)|não funcion|nao funcion|não era isso|nao era isso|você esqueceu|voce esqueceu|desfaz)\b/i;

const EDIT_TOOLS = /^(?:edit|write|multiedit|apply_patch|notebookedit|str_replace_editor|str_replace|create_file|update_file)$/i;

export const IDLE_GAP_MS = 30 * 60 * 1000;

export function baseToolName(name: string): string {
	return name.replace(/^mcp__.*__/, "").replace(/^functions\./, "");
}

export function isEditTool(name: string): boolean {
	return EDIT_TOOLS.test(baseToolName(name));
}

export function isCorrection(text: string): boolean {
	return CORRECTION.test(text.slice(0, 600));
}

export interface SessionSignals {
	nUser: number;
	nAssistant: number;
	nToolCalls: number;
	nToolErrors: number;
	nCorrections: number;
	nInterruptions: number;
	nRetries: number;
	nEdits: number;
	durationMs: number;
	activeMs: number;
}

/** Marks per-turn flags in place and returns session totals. */
export function deriveSignals(turns: Turn[]): SessionSignals {
	const s: SessionSignals = { nUser: 0, nAssistant: 0, nToolCalls: 0, nToolErrors: 0, nCorrections: 0, nInterruptions: 0, nRetries: 0, nEdits: 0, durationMs: 0, activeMs: 0 };
	const erroredTools = new Set<string>();
	let seenTypedUser = false;
	let prevTs: number | null = null;
	let first: number | null = null;
	let last: number | null = null;

	for (const t of turns) {
		const at = t.ts ? Date.parse(t.ts) : Number.NaN;
		if (Number.isFinite(at)) {
			if (prevTs !== null && at >= prevTs) {
				t.durationMs = at - prevTs;
				if (t.role !== "user" && t.durationMs < IDLE_GAP_MS) s.activeMs += t.durationMs;
			}
			prevTs = at;
			first ??= at;
			last = at;
		}
		if (t.role === "user") {
			if (t.injected) continue;
			s.nUser++;
			if (seenTypedUser && isCorrection(t.text)) {
				t.isCorrection = true;
				s.nCorrections++;
			}
			seenTypedUser = true;
		} else if (t.role === "assistant") {
			s.nAssistant++;
			if (t.interruption) s.nInterruptions++;
			const calls = t.toolCalls ?? [];
			s.nToolCalls += calls.length;
			s.nEdits += calls.filter((c) => isEditTool(c.name)).length;
			// A provider error that the harness retried, or a call to a tool whose last
			// call failed, both count as one retry for this turn.
			if (t.stopReason === "error" || calls.some((c) => erroredTools.has(baseToolName(c.name)))) {
				t.isRetry = true;
				s.nRetries++;
			}
			for (const c of calls) erroredTools.delete(baseToolName(c.name));
		} else if (t.role === "tool") {
			if (t.isError) {
				s.nToolErrors++;
				if (t.toolName) erroredTools.add(baseToolName(t.toolName));
			}
		}
	}
	if (first !== null && last !== null) s.durationMs = last - first;
	return s;
}

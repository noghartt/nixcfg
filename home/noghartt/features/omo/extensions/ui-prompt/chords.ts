import type { Theme } from "@earendil-works/pi-coding-agent";
import { decodeKittyPrintable, matchesKey } from "@earendil-works/pi-tui";

export const LEADER_KEY = "ctrl+x";

export type ChordTarget = {
	runCommand(command: string): void;
	emit(event: string): void;
	replayLeader(): void;
};

export type Chord = { key: string; label: string; run: (target: ChordTarget) => void };

export const CHORDS: readonly Chord[] = [
	{ key: "l", label: "resume", run: (target) => target.runCommand("/resume") },
	{ key: "a", label: "agents", run: (target) => target.emit("agents:cycle") },
	{ key: "y", label: "copy", run: (target) => target.replayLeader() },
];

export type ChordResolution = { kind: "cancel" } | { kind: "run"; chord: Chord } | { kind: "passthrough" };

export function resolveChord(data: string): ChordResolution {
	if (matchesKey(data, "escape")) return { kind: "cancel" };
	const typed = decodeKittyPrintable(data) ?? data;
	const chord = CHORDS.find((candidate) => candidate.key === typed);
	return chord ? { kind: "run", chord } : { kind: "passthrough" };
}

export function chordHint(theme: Theme): string {
	const keys = CHORDS.map((chord) => `${theme.fg("accent", chord.key)} ${theme.fg("muted", chord.label)}`);
	keys.push(`${theme.fg("accent", "esc")} ${theme.fg("muted", "cancel")}`);
	return `${theme.fg("accent", LEADER_KEY)}${theme.fg("dim", " \u203a ")}${keys.join(theme.fg("dim", " \u00b7 "))}`;
}

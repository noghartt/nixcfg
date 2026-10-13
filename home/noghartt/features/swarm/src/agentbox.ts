// Pure naming and command construction for the agentbox backend (Mellon's nspawn sandboxes).
// No process spawning here, so the argument lists and scripts are unit-testable.

import { createHash } from "node:crypto";
import { shellQuote as q } from "./shell.ts";

// agentbox-root accepts a-z, 0-9 and dashes, at most 31 characters.
export const BOX_MAX = 31;

export const SIZE_CLASSES = ["small", "medium", "large"] as const;
export type SizeClass = (typeof SIZE_CLASSES)[number];
// The memory limit of each class (agentbox size). The scheduler budgets live members against it.
export const SIZE_MEMORY: Record<SizeClass, string> = { small: "8g", medium: "16g", large: "32g" };

const clean = (value: string): string =>
	value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");

export type BackendChoice = "sbx" | "local" | "agentbox";

// "auto" is agentbox where its CLI exists (Mellon) and sbx elsewhere (Palantir).
export function pickBackend(requested: string, agentboxOnPath: boolean): BackendChoice {
	if (requested === "auto") return agentboxOnPath ? "agentbox" : "sbx";
	if (requested === "sbx" || requested === "local" || requested === "agentbox") return requested;
	throw new Error(`unknown backend ${requested}`);
}

// One sandbox per member. Names that do not fit keep a prefix plus a hash of the full name, so
// two long member names sharing their first characters still get distinct sandboxes.
export function boxName(swarmId: string, member: string): string {
	const full = `swarm-${clean(swarmId).slice(0, 8)}-${clean(member)}`.replace(/-+$/, "");
	if (full.length <= BOX_MAX) return full;
	const tag = createHash("sha1").update(full).digest("hex").slice(0, 4);
	return `${full.slice(0, BOX_MAX - 5).replace(/-+$/, "")}-${tag}`;
}

export function ensureArgs(box: string, repo: string, options: { from?: string; net?: string; size?: string } = {}): string[] {
	return [
		"ensure",
		box,
		"--seed",
		repo,
		...(options.from ? ["--from", options.from] : []),
		...(options.net ? ["--net", options.net] : []),
		...(options.size ? ["--size", options.size] : []),
	];
}

// The last stdout line of `agentbox ensure` is the sandbox directory that maps to the seeded path.
export function lastLine(output: string): string {
	return output.trim().split("\n").pop()?.trim() ?? "";
}

// The member's OmO runs on the host; cloud-mode reads these to aim its tools into the sandbox.
export function cloudEnv(repo: string, box: string): Record<string, string> {
	return { OMO_CLOUD: `local:${repo}`, OMO_CLOUD_SANDBOX: box };
}

export function execArgs(box: string, dir: string, script: string): string[] {
	return ["exec", box, "--", "bash", "-lc", `cd ${q(dir)} && (${script}\n)`];
}

export const collectArgs = (box: string, repo: string): string[] => ["collect", box, repo];

export const rmArgs = (box: string): string[] => ["rm", box, "--yes"];

// Puts the member on its branch inside its sandbox, creating it at the first start point that
// resolves: the host's commit for the start ref, the ref itself, or its remote-tracking copy
// (a sandbox cloned from a parent's sandbox may only have the parent's branch as origin/...).
// The start ref also becomes a local branch so later `git diff <start>..HEAD` evidence works.
export function branchScript(dir: string, branch: string, startRef: string, candidates: string[]): string {
	return [
		"set -e",
		`cd ${q(dir)}`,
		`if git show-ref --verify -q ${q(`refs/heads/${branch}`)}; then git switch -q ${q(branch)}; exit 0; fi`,
		`commit=""`,
		`for ref in ${candidates.map(q).join(" ")}; do`,
		`  if commit=$(git rev-parse --verify -q "$ref^{commit}"); then break; fi`,
		"  commit=",
		"done",
		`[ -n "$commit" ] || { echo ${q(`start point ${startRef} is not in this sandbox`)} >&2; exit 1; }`,
		`git show-ref --verify -q ${q(`refs/heads/${startRef}`)} || git branch ${q(startRef)} "$commit"`,
		`git switch -q -c ${q(branch)} "$commit"`,
	].join("\n");
}

// Only commits leave a sandbox, so leftovers are committed before their branches are collected.
export function leftoversScript(dir: string, message: string): string {
	return `cd ${q(dir)} && if [ -n "$(git status --porcelain)" ]; then git add -A && git commit -qm ${q(message)}; fi`;
}

// Where `agentbox collect` lands a member's branch in the host repository.
export const hostBranch = (box: string, branch: string): string => `sandbox/${box}/${branch}`;

// Where a worker runs and what its sandbox may reach: the config's defaults, never wider.
import { existsSync } from "node:fs";
import { join } from "node:path";

export type PlacementMode = "sandbox" | "shared" | "worktree";
export const NETS = ["none", "dev", "open"] as const;
export const SIZES = ["small", "medium", "large"] as const;
export type Net = (typeof NETS)[number];
export type Size = (typeof SIZES)[number];

export interface WorkersConfig {
	placement: "auto" | "sandbox" | "worktree";
	// Catalog variables (agentbox env) a host-side leader may give workers, with what each is for.
	envAllowed: Record<string, string>;
	allowOpenNet: boolean;
	net: Net;
	size: Size;
}

export type Harness = "omo" | "pi";

export function onPath(command: string, path = process.env.PATH ?? ""): boolean {
	return path.split(":").some((dir) => dir && existsSync(join(dir, command)));
}

// Only OmO has cloud-mode, which is what points a worker's tools into its sandbox. A Pi
// worker given a sandbox would run its tools on the host with destructive-guard's write and
// edit checks switched off, so Pi always gets worktrees.
export function resolveMode(
	setting: WorkersConfig["placement"],
	agentbox: boolean,
	harness: Harness,
): { mode: "sandbox" | "worktree"; note: string } {
	if (setting === "worktree") return { mode: "worktree", note: "Workers use host worktrees (workers.placement)." };
	if (harness !== "omo") {
		return { mode: "worktree", note: "Workers use host worktrees: sandbox workers need OmO's cloud-mode, and this leader runs Pi." };
	}
	if (!agentbox) {
		return {
			mode: "worktree",
			note: `Workers use host worktrees: agentbox is not on PATH${setting === "sandbox" ? " (workers.placement asks for sandboxes)" : ""}.`,
		};
	}
	return { mode: "sandbox", note: "Each isolated worker gets its own agentbox sandbox on this host." };
}

export interface PlacementInput {
	kind: "work" | "review";
	// Its own checkout was asked for (isolation "worktree"); false for isolation "current".
	isolated: boolean;
	// Set for nodes with `workdir`: whether that upstream node runs in its own sandbox.
	upstream?: { sandbox: boolean };
	leaderCloud: boolean;
	mode: "sandbox" | "worktree";
}

export interface PlacementChoice {
	mode: PlacementMode;
	net: Net;
	size: Size;
	env: string[];
}

export function placementMenu(input: PlacementInput): PlacementMode[] {
	if (input.upstream) {
		// A reviewer judges the reviewed checkout itself, never a copy of its commits.
		if (input.kind === "review" || !input.upstream.sandbox) return ["shared"];
		return ["shared", "sandbox"];
	}
	if (!input.isolated) return ["shared"];
	// A cloud-mode leader works on the cloud host, where a local worktree would be the wrong place.
	if (input.leaderCloud) return ["sandbox"];
	return input.mode === "sandbox" ? ["sandbox", "worktree"] : ["worktree"];
}

export function defaultPlacement(input: PlacementInput, workers: WorkersConfig, allowedEnv: string[]): PlacementChoice {
	return {
		mode: placementMenu(input)[0],
		net: workers.net === "open" && !workers.allowOpenNet ? "dev" : workers.net,
		size: workers.size,
		env: [...allowedEnv],
	};
}

export function splitVars(value: string | undefined): string[] {
	return (value ?? "")
		.split(",")
		.map((name) => name.trim())
		.filter(Boolean);
}

// Where a worker runs: its own Git worktree on this machine, or a checkout it shares.

export type PlacementMode = "shared" | "worktree";

export interface PlacementInput {
	// Its own checkout was asked for (isolation "worktree"); false for isolation "current".
	isolated: boolean;
	// Set for nodes with `workdir`: they work in that upstream node's checkout.
	upstream: boolean;
	// The leader runs in OmO cloud mode, so the checkout lives on the cloud host.
	leaderCloud: boolean;
}

export function placementMode(input: PlacementInput): PlacementMode {
	if (input.upstream || !input.isolated) return "shared";
	// Worktrees are created on this machine; a cloud-mode leader's checkout is on another host.
	if (input.leaderCloud) throw new Error('worktree isolation is unavailable while the leader runs in cloud mode; use isolation "current"');
	return "worktree";
}

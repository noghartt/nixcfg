# Orchestrator

The Pi `orchestrator` extension (Pi only; OmO no longer loads it, so the OmO-leader paths below
are dormant) runs a leader + worker mesh. `orch "<goal>"` or
`/orchestrate <goal>` sets the leader model (default Opus 5.5 at `xhigh`, the first of
`leader.models` in `orchestrator/config.json` with credentials; `ORCH_LEADER_MODEL` overrides).
The leader plans and judges; no second model sits between it and the workers, so a settled
worker reaches the leader as soon as it finishes.

## Graph

The leader plans each goal as a dependency graph and sends it whole with `orch_spawn`. A node has a
`name`, a `task`, acceptance `criteria`, and optionally `after` (start once those nodes are
accepted; dependents of a failed or rejected node are skipped), `workdir` (run in an upstream
node's checkout), `repo` (an absolute path to another repository, seeded and branched from its own
HEAD and collected back into it, never the leader's), `isolation`, `model`, and `kind: "review"`
with `fixes`. Pending nodes queue behind `maxWorkers` (6).

## Settling

- Work nodes: when a worker settles, the orchestrator collects evidence itself (files changed since
  spawn, diff stat, commits, the worker's tool calls) and attaches it to the result. The node
  becomes `done_ungated` and its dependents start. The leader checks the report and evidence:
  `orch_verdict` rejects it (pending dependents are skipped) and `orch_send` reopens it. If
  evidence collection fails, the result says so and the leader checks the checkout itself.
- Review nodes: the `VERDICT: PASS|FAIL` line at the end of the report decides. PASS accepts.
  FAIL with a `fixes` target and rounds left (`maxFixRounds`, 2) parks the reviewer, reopens the
  target with the findings, and the reviewer re-reviews the fix. FAIL with no rounds left or no
  target rejects. A review without a VERDICT line becomes `needs_leader`.
- A blocked worker also becomes `needs_leader`; its dependents wait for the leader's
  `orch_verdict` or `orch_send`. `orch_verdict` accept also reconsiders nodes skipped because
  of that node.
- Turns a user types into a finished worker's pane are not tracked as node attempts.

## Models

Workers run on the pool's `fallbackWorker` (Sonnet 5.5) unless the leader names another pool entry
with `orch_spawn`'s `model`. Fable 5.1 and GPT-6 Astra are `onRequest` specialists: they run only
where the leader names them, for the specific part that needs them. An entry's `spill` models take
a pick when its provider's limits reach `spillAt` (85%) and the other provider's do not, read from
the statusline's shared limits cache.

## Where workers run

Inside Herdr each worker is a visible, interactive harness in its worktree workspace's root pane
(`herdr worktree create`, under `~/.herdr/worktrees/<repo>/`, grouped under the repo's main
workspace and branched from the leader's commit even when the leader runs in a linked worktree,
since Herdr only creates worktrees from the main checkout); `workdir` nodes split the upstream
worker's pane and shared-checkout nodes split the leader's, and dialogs appear in the worker's own
pane. Outside Herdr, workers are hidden RPC children in `git worktree add` checkouts at the same
path, and their dialogs are relayed to the leader's UI.

Isolated nodes (the default `worktree` isolation) get their own Git worktree on this machine;
`workdir` nodes and reviewers share the checkout they build on or review, and shared-checkout
nodes (isolation `current`) stay plain guarded local workers. A leader in OmO cloud mode
(`OMO_CLOUD`) cannot create worktrees: its nodes need isolation `current` (`repo` is refused),
run as local worker processes whose cloud-mode points at the leader's host directory, and
evidence is read with git over cloud-mode's SSH master (`orchestrator/cloud.ts`).

## Leader tools

- `orch_spawn`, `orch_wait`, `orch_status`, `orch_stop`, `orch_send`, `orch_verdict`, and the
  shared board.
- `orch_consult` asks Fable 5.1, or GPT-6 Astra when Claude's limits are at `spillAt`, one question
  with leader-supplied context through a one-shot read-only RPC child. Advisory only.
- `orch_publish` pushes an accepted worktree node's branch (once it has commits) to
  origin over SSH under a leader-chosen name, never forced and never the default branch, and can
  open a draft PR.

Workers get mesh tools (`mesh_send` to a peer, `leader`, or `*`; `mesh_wait`) and the board.
Workers never spawn or redirect each other.

## Plumbing

The leader drives workers through per-worker JSONL files in the run directory (`ctl/` for prompts,
model switches, and stop; `events/` for ready, mesh sends, settled reports, and exit), and workers
deliver their own mesh mail, into `mesh_wait` or as a steer. Every message the orchestrator relays
into a session (tasks, leader commands, mesh mail, leader notices) is prefixed `[orchestrator] ` at
one delivery point, and worker and leader system prompts vouch for that prefix so mid-task steers
are not discounted as injected text. Worker state is published on `pi.events`
(`orchestrator:state`) for the statusline sidebar.

Every settled node attempt appends one line to `$XDG_STATE_HOME/agent-evals/outcomes.jsonl`
(outcome log v1: run, node, placement, model, verdict, duration, worker and leader session files),
which `aeval ingest` imports.

`/agent [omo|orchestrator]` (or `--agent`, or the `agents:cycle` event) switches the session's
primary agent: orchestrator mode applies the leader model, tools, and planning prompt so each typed
request becomes a run's goal, and switching back restores the saved model; the choice persists as an
`agents-active` session entry and is announced on `agents:active`. Workers (`ORCH_ROLE=worker`)
always stay `omo`.

Unit tests sit next to the sources (`bun test` in the orchestrator dir) and are left out of the
package.

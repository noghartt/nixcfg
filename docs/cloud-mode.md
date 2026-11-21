# Cloud mode

The OmO-only `cloud-mode` extension makes a session act on a remote host over SSH while OmO
itself (TUI, models, auth, memory) stays local: `omo --cloud <host[:path]>` or
`/cloud <host[:path]> | off`. The default directory is the same home-relative path on the
host. `read`/`write`/`edit` are rebuilt with remote operations, `grep` runs ripgrep on the
host, and `bash` (direct, from eval's `tool.*`, and `!`) is rewritten in `tool_call` to
`ssh -tt` inside OmO's local PTY, so background sessions, `bash_input`, `kill_bash`, and
`monitor` keep working. Bash gets its own connection because killing a multiplexed client
leaves the remote process running; file operations share a ControlMaster under
`~/.ssh/omo-cloud/`. Eval kernels stay local (the prompt confines them to `tool.*`), and LSP,
`worktree_agents`, `apply_patch`, and computer use are switched off. A target that fails to
resolve blocks every tool instead of falling back to local. The target persists as a
`cloud-mode` session entry and reaches subagents through `OMO_CLOUD` (the top-level session
only; subagents get their context from the prompt, see below), under which destructive-guard
skips its local-disk `write`/`edit` checks. Targets need bash, ripgrep, and
coreutils `timeout`. `--cloud <host> --sandbox[=name]` (or `/cloud <host> --sandbox`) runs
the tools inside one of the host's `agentbox` sandboxes instead: every remote command is
wrapped in `agentbox exec`, the sandbox is created from the host directory's repo on first
use (default name `<repo>-<session id tail>`), and it persists until `agentbox rm` or idle
expiry; when `ensure` recreates an expired one, cloud mode warns and points the prompt at
the archived bundles. The
entry and `OMO_CLOUD_SANDBOX` carry the name, so resume and subagents reattach. Pass a
name as `--sandbox=name`: a bare `--sandbox` followed by a word consumes it as the value.
`agentbox exec` sets `AGENTBOX_HOST` (the sandbox's tailnet name), which the prompt passes on
so the model can hand out reachable addresses. `--env KEY,KEY` (or `/cloud ... --env=K,K`)
sets the sandbox's catalog opt-ins (an empty list clears, no flag keeps them); the effective
list goes to the prompt and `OMO_CLOUD_ENV`, which orchestrator workers pass on. The
`publish` tool (`cloud-mode/publish.ts`) is the write path to GitHub: it bundles a branch out
of the target, fetches it into the local clone at the session's cwd as
`sandbox/<box or host>/<branch>`, pushes it over SSH with the local keys (an HTTPS
GitHub origin is rewritten to SSH: Git never uses HTTPS here; a 1Password SSH approval may be
needed), never forced and never to origin's default branch, under the name the agent picks by the
repo's conventions, and optionally opens a draft PR. `--cloud local --sandbox` targets this
machine's own sandboxes with no SSH: every command (PTY bash included) runs `agentbox exec`
in a local bash, so OmO on Mellon (in its Herdr, reached as a saved machine) drives sandboxes and an
orchestrator's sandboxed workers unattended, and pushes with Mellon's GitHub key. `local`
without `--sandbox` is refused: it would only bypass destructive-guard's write/edit checks.
Subagents get isolation of their own. A sandboxed session's `task` calls get a
`<!--cloud-mode:...-->` marker appended to each prompt (parent sandbox, host spec, env opt-ins,
net/size, and whether the requested agent type is read-only); the prompt is the one channel that
reaches every hosting mode, because the task daemon runs several children in one process and a
shared environment would race between parallel lanes. A child recognises itself by
`ctx.sessionContext.role` (child, dag_child, member) or `OMO_SENPI_TASK_RPC_CHILD=1`, reads its
agent type from the task record `tasks/<id>.json` when readable, and at its first prompt either
keeps the parent's sandbox (explore, librarian, oracle, plan-consultant, plan-reviewer, OmO's
code/gate reviewers, or tool lists with no write/edit/bash) or creates `<parent>-<short>` with
`agentbox ensure --seed <dir> --from <parent>` (the parent's clone at its HEAD, so only committed
work crosses) on branch `task/<parent>/<short>`. After every turn and on quit it commits
leftovers and runs `agentbox collect --into <parent>`, so the branch appears in the parent's
clone as `sandbox/<box>/task/<parent>/<short>`; the child's final message must end with
`Branch: <that ref>`, and its `handoff` tool delivers on demand. The parent merges it or
`publish`es it by that name. OmO's in-process agent types load no extensions and reuse the
parent's tool objects, so they stay in the parent's sandbox. `--net PROFILE` and `--size CLASS`
(also `/cloud ... --net --size`) go to `agentbox ensure` and travel to children like the env
opt-ins (`OMO_CLOUD_NET`, `OMO_CLOUD_SIZE`). Children never write the process environment.
Spawns other than the `task` tool (workpool, workflow, team) are not tagged and rely on the
environment.

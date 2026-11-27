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
`cloud-mode` session entry and reaches subagents and orchestrator workers through
`OMO_CLOUD` (`host:/resolved/dir`), under which destructive-guard skips its local-disk
`write`/`edit` checks. Only the top session writes `OMO_CLOUD`; task children (recognised by
`ctx.sessionContext.role` or `OMO_SENPI_TASK_RPC_CHILD=1`) act in the same remote directory but keep
their agent type's tool set (a read-only type gets no remote writers) and never get `publish`.
Sessions left over from the removed sandbox support (an entry with a `sandbox` field, an inherited
`OMO_CLOUD_SANDBOX`, or a `local`/`exe` target) are blocked rather than resumed against the host
directory, until `/cloud <host[:path]>` or `/cloud off`. Targets need bash, ripgrep, and coreutils
`timeout`.

The top session's `publish` tool (`cloud-mode/publish.ts`) pushes with the local identity, whatever
credentials the remote host may hold: it bundles a branch out of the remote checkout, fetches it into the
local clone at the session's cwd as `cloud/<host>/<branch>`, pushes it over SSH with the local
keys (an HTTPS GitHub origin is rewritten to SSH: Git never uses HTTPS here; a 1Password SSH
approval may be needed), never forced and never to origin's default branch, under the name the
agent picks by the repo's conventions, and optionally opens a draft PR.

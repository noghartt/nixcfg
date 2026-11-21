# Destructive guard

The Pi `destructive-guard` (also loaded by OmO) approves in layers: self-harm is blocked
outright, temp-dir deletions, session-created files, and session-started processes pass
deterministically, as do an orchestrator worker's writes, edits, and `rm` inside its own
run-created worktree (`ORCH_WORKTREE`; the root, `.git`, and sensitive paths still ask),
and so do `rm`/`unlink`, truncate, `cp`/`mv -f`, recursive `chmod`/`chown`, and write
overwrites whose every target is inside the project (the git toplevel of the session cwd
or any worktree of that repository, such as Herdr's under `~/.herdr/worktrees/`, not of a
`cd` target; a nested worktree's own root still asks; never a repo at `$HOME` or one holding the agent's config; its root,
`.git`, `.env`/credential files, root-level bare or dot-led globs still ask). Destructive
Git commands, kills of foreign processes, and system-level categories always ask; everything
else asks the user, or is refused when no UI.
In an agentbox sandbox (`OMO_CLOUD_SANDBOX`) bash, write, and edit skip it entirely, since
they run inside the disposable container; destructive-named tools (MCP and the like) act
outside it and keep their checks. A turn typed as `/unsupervised` refuses instead of asking
until the next typed (non-steer) input; `OMO_UNSUPERVISED` carries that into subagents and
orchestrator workers, which also get a no-questions note.
Subagents have no UI, so their writes to agent configuration (anything under `~/.omo`,
including OmO's isolated task clones in `~/.omo/wt`, and extension sources) are refused: have
them stage edits under `/tmp` and copy the result in from the parent session.

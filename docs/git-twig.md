# git twig

[git-twig](https://github.com/leostera/git-twig) (`features/git-twig/`, every host) makes ordinary
linked Git worktrees whose tracked files are native copy-on-write clones (APFS on the Macs,
reflink on Btrfs/XFS), so a worktree per agent costs little disk. Elsewhere, and for requests it
cannot clone, it runs stock Git itself. `git twig new` takes `git worktree add`'s arguments; the
result is a plain worktree, so `git worktree list/remove` and everything else work unchanged.
`TWIG_TRACE=1` on a create shows whether CoW was used (`APFS CoW: verified tracked files`) or
why it fell back (`stock Git: ...`). One fallback to avoid: twig uses stock Git when the
destination's parent directory does not exist, so every caller below creates it first.

It is built from source at a release tag (`package.nix`). Five upstream tests are skipped
because they call macOS-only tools that the sandbox's coreutils replace; two more are skipped on
Linux, where the build sandbox refuses setgid bits and has no `/bin/cat`. The bundled skill
(`git twig skill`) is linked into Claude Code, Codex and Pi's agent dir, which pi-durable shares.

## Who creates worktrees through it

Everything in this config that makes worktrees creates them with twig:

- **pi-durable**: isolated subagents (`src/worktrees.ts`), and its system prompt tells the model
  to use `git twig new` for worktrees it makes through bash. `PI_DURABLE_TWIG=0` uses plain
  `git worktree add`; `git-twig` is on pi-durable's own PATH.
- **Pi/OmO extensions**: `worktree-agents` and the orchestrator's worktrees outside Herdr.
- **Herdr**: `herdr worktree create` (and so the orchestrator's workers inside Herdr) runs
  `git twig new` through `features/herdr/git-twig.patch` on the pinned source. Herdr runs
  `git`, which finds `git-twig` on PATH from `home.packages`. On a Herdr bump the patch
  fails loudly if `src/worktree.rs` moved; re-cut it against the new source.
- **Claude Code**: `WorktreeCreate`/`WorktreeRemove` hooks (`cli/agents/claude-worktree.sh`)
  replace Claude's own git logic for `--worktree`, `EnterWorktree`, subagent isolation and
  background sessions. They keep Claude's layout (`.claude/worktrees/<name>` at the main
  checkout, branch `worktree-<name>`, base per `worktree.baseRef`, which Nix sets to `fresh`:
  the fetched `origin/HEAD`, without tracking it), and redo what a hook replaces: copying
  `.worktreeinclude` files, ignoring `.claude/worktrees/` in `info/exclude`, and deleting the
  branch on removal. Nix owns only these two events in `settings.json`'s `hooks`; other events
  added at runtime survive activation.

The other cases fall back on the skill, not on code: Codex and OpenCode have no worktree hook,
and a model running `git worktree add` through bash is only steered by the skill (and, in
pi-durable, the prompt).

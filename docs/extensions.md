# Small extensions (herdr-fork, findings-cache)

The Pi `herdr-fork` extension (also loaded by OmO): inside Herdr, `/fork` writes the fork as a
new session file (parent = the original, which stays untouched) and opens it in a new focused
Herdr pane split from the current one, running the same harness with the forked message
prefilled; `/clone` and non-Herdr sessions keep native behaviour.

The OmO-only `findings-cache` extension saves finished `explore`/`librarian` results (foreground
`task` results and background wake entries) to `<git-common-dir>/omo-findings/`, shared by every
worktree of a repo, and injects a once-per-session "Cached research" index (newest 30, framed
as leads to re-verify) into the system prompt. Reading a finding refreshes its mtime;
findings untouched for 14 days are pruned.

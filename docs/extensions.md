# Small extensions (herdr-fork, findings-cache, antigravity, rex)

The Pi `herdr-fork` extension (also loaded by OmO): inside Herdr, `/fork` writes the fork as a
new session file (parent = the original, which stays untouched) and opens it in a new focused
Herdr pane split from the current one, running the same harness with the forked message
prefilled; `/clone` and non-Herdr sessions keep native behaviour.

The OmO-only `findings-cache` extension saves finished `explore`/`librarian` results (foreground
`task` results and background wake entries) to `<git-common-dir>/omo-findings/`, shared by every
worktree of a repo, and injects a once-per-session "Cached research" index (newest 30, framed
as leads to re-verify) into the system prompt. Reading a finding refreshes its mtime;
findings untouched for 14 days are pruned.

The `antigravity` extension (bare `pi` only, from `features/pi-next/extensions/`) registers an
`antigravity` tool that hands a self-contained task to the Antigravity CLI as a sub-agent:
`agy --output-format stream-json --model <id> -p <task>` in the session cwd. agy keeps its own
login, quota, tools and conversations, so this stays within the official CLI instead of
borrowing its OAuth for Pi's `/model` (Google has suspended accounts for that). Pi gets the final
answer, a step log streamed live, the conversation ID (pass it back as `conversationId` to
continue) and token usage at zero cost. Headless agy auto-denies anything that would prompt,
which includes file writes even with `--mode accept-edits`, while its own policy still lets
harmless commands such as `ls` run; denials are reported back. `allowWrites` adds
`--dangerously-skip-permissions` and always asks the user first (refused without a UI). The
`agy` binary is the vendor's self-updating install in `~/.local/bin`, not Nix-managed; the
model list in the tool description is hand-copied from `agy models`.

`pi-durable` cannot load Pi extensions, so it carries a Durable port in
`features/pi-durable/src/antigravity.ts`: same name, parameters, agy invocation, result text,
and prompt snippet and guidelines (fed to `prompt.ts`). The differences come from Durable: the
live log gains a line per finished agy step (running output is append-only), the conversation
ID is committed as soon as agy reports it, a run cut off by a crash is reported as interrupted
rather than started again, and the `allowWrites` question goes through `approvals.ts` to the
TUI. Change both copies together, model list included. The port also registers a tools-only
`antigravity-subagent` tool (never offered to the model) for subagent profiles with
`runner: antigravity`; see `docs/pi-durable.md`.

The `rex` extension (bare `pi` only, `features/pi-next/extensions/rex/`) reports `pi`'s state to
Rex and adds Rex's session context to the prompt; pi-durable's copy is `src/rex.ts`. See `docs/rex.md`.

# Statusline

The Pi `statusline` extension (also loaded by OmO) replaces the footer, filtering OmO's
`"  omo-native"` badge status, and adds an OpenCode-style right sidebar column (title,
OmO's `/goal` (its `goal`/`goal-wait` statuses plus the objective from
`<sessionDir>/extensions/goal/<sessionId>.json`, dropped from the footer while the column is
shown), context, session tokens with a tokens-per-turn sparkline, Claude/ChatGPT limits, agent tree,
files edited this session with `git diff HEAD` stats, git branch/upstream/status, harness
version). Git runs via `pi.exec` off the render path. Limits (`statusline/limits.ts`): Claude
(5h, 7d, per-model weekly, extra-usage spend from `api/oauth/usage`, accounts with identical
tokens deduped and pooled) and ChatGPT (`chatgpt.com/backend-api/wham/usage`). Tokens are read
read-only from Pi's and OmO's `auth.json` and Codex CLI's `~/.codex/auth.json`, never
refreshed. Under OmO, Claude comes from OmO's own usage polling instead: OmO signs Claude
accounts in through the bundled Claude CLI, whose tokens stay in the CLI's store (Keychain on
macOS), so the column reads `pi.getSubscriptionLimits()` (providers `anthropic-subscription`
and `claude-sdk-oauth`, pooled the same way, refreshed on `onSubscriptionLimits`), and that
reading replaces the fetcher's Claude entry. It carries no extra-usage spend, and the emails
come from the account profiles OmO records in `auth.json`. Every process shares one secret-free cache in `$TMPDIR` behind an exclusive lock
file, so only one TUI process fetches per 5 minutes (after-turn refreshes pass the same gate),
and failures wait out the TTL. Each provider lists its signed-in account emails (ChatGPT's
from the token's JWT claims, Claude's from `api/oauth/profile` once per token); they stay in
process memory, never in the shared cache. Bars carry a pace tick (even-burn position) and turn amber when
ahead of it; a window burning at 1.1x the even rate or more adds "running hot"/"at risk" and
the projected time it hits 100% (bands from fersilva16's config). A Todo section mirrors
OmO's todo list (latest `senpi.todo-state` entry or `todo` result on the branch): phase
progress, the active phase's tasks, and OmO's `todo_owed_reminder` state (`reminded n/2`,
`stopped · N open`, cleared on user input). The statusline emits `statusline:sidebar`
(`{ shown }`) on `pi.events`, and OmO's `ui-chrome` blanks OmO's own `todo-sidebar`
widget above the prompt while the column is on screen. The column wraps the fullscreen TUI's layout root
in a pi-tui `HStack`, so it only exists with `tuiMode = "fullscreen"`, which Pi's settings
set and OmO's baseline inherits; regular mode and narrow terminals fall back to a full footer.
Subagents come from `task` tool results and the `omo-senpi:wake` completion entries in the
session branch; OmO exposes no task events.

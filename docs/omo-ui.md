# OmO UI (ui-prompt, ui-chrome)

OmO's opencode-style UI is two OmO-only extensions that leave the statusline's footer and
sidebar alone. `ui-prompt` replaces the editor (public `CustomEditor`) with a card: accent bar,
filled background, an `agent · model provider · thinking` info line that also carries the
working indicator, and ask-user questions drawn inside the card (via the `ask-user:*` bus). It
also sets the terminal title (session name or first prompt, cwd, busy `●`) and, inside
Herdr, which ignores pane titles, renames its tab to the session name (only a tab still on
Herdr's numeric default label; restored on exit), appends a
TUI-only `▣ agent · model · duration` turn footer entry, and switches to a blinking bar
hardware cursor for the session. Engine internals it needs (InteractiveMode's editor
container for questions, paste state, `Editor.prototype.render`) are confined to its
`host.ts`, guarded and `Symbol.for`-idempotent across `/reload`; recheck them on OmO bumps.
`ui-chrome` redraws everything else, all through internals listed in its `core/host.ts`
header (the public route cannot reach MCP/plugin tool rows or OmO's built-in screens):
every screen OmO puts in the editor's place (extension dialogs, model/thinking pickers,
`/tree`, `/resume`, `/settings`, `/login`, ...), `/help`, `/history`, `/hotkeys`, `/session`,
`/changelog`, and multi-line notifies become centred modals over a faded backdrop while OmO
keeps their keys; tool rows collapse to one header plus three output lines until Ctrl+O; user
messages, thinking, `!cmd`, summaries, code blocks, notices, and selected widgets become
cards. Components that must stay inline set `Symbol.for("omo-ui-chrome.inline")` (ui-prompt's
question card does). ui-chrome re-wraps the editor container's `addChild` from OmO's original
on `/reload`, so ui-prompt re-installs its own hook before each question.

Both packages record the OmO release their host internals were checked against as `omoVerified` in their `package.json`; `features/omo/extensions/default.nix` warns at evaluation when the pinned OmO differs, so a bump prompts a recheck of `host.ts`.

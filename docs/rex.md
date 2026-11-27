# Rex

Rex (Superlogical's terminal multiplexer) replaced Herdr as the terminal workspace; it is installed
and updated outside Nix (`rex skill setup` puts its skill into `~/.agents/skills/rex`, which
Claude Code, Codex, OpenCode and Pi all read, and its SessionStart hook into Claude Code and Codex).
Pi has no hook support, so both Pi harnesses carry their own integration, active only inside a Rex
terminal (`REX_SESSION` set) and, for `pi`, only in the TUI (in rpc/json modes stdout is the protocol):

- **Program status** ([OSC 7501](https://www.superlogical.com/rex/docs/build/program-status)).
  The agent reports what it does, and Rex shows it on unfocused tabs and in its session picker:
  `working` with the running tool, `blocked` while a question or approval waits on the user,
  then `done` with the answer's first line, `error` with the failure, or `idle` after Esc.
  `done` and `error` stay until Rex sees the user return. Quitting clears every record.
  pi-durable adds one child record per other conversation at work (`agents/<id>`, titled
  with the subagent's name), so background subagents show while main is idle.
- **Session context.** The text Rex's hook gives Claude Code (`rex __internal session-start
  --agent pi`: the Rex session and pane IDs, how to use `rex`, and to name the Rex session after
  the task) becomes a `rex` system prompt section, read once per process from the installed
  `rex`, so a Rex upgrade updates it. Its session-naming paragraph is swapped for one that names
  the agent's own tab (`rex window rename`, window ID resolved with `rex whoami --json`) and
  forbids renaming the session, since one session holds many tabs; if Rex rewords the paragraph
  the tab one is appended instead. pi-durable gives it to user-facing conversations only:
  subagents would otherwise rename the user's tab. The section also tells the agent to use Rex
  unprompted and to read the `rex-workflows` skill.
- **`rex-workflows` skill** (`features/cli/agents/skills/rex-workflows/`, linked into every
  harness by `skills.nix`). Rex's own guide covers how each command works; this skill covers when
  to use them: background tabs for servers and long jobs (paired with pi-durable's `watch` via
  `rex wait`), tabs for big diffs or output, reading other panes with scrollback (`format`, not
  `capture`), other agents' `program_status`, remote hosts (`-S`), API-only layouts and Lua.
  It overrides the guide's session naming. Recheck it against `rex __internal skill` and
  `rex api list` after Rex upgrades.

Code: `features/pi-durable/src/rex.ts` (status from the TUI's view and approvals, prompt section
in `prompt.ts`) and `features/pi-next/extensions/rex/` for `pi` (Pi's agent, tool, `ui_prompt`
and `agent_settled` events, `before_agent_start` for the section). Change both together.

To watch what Rex receives: `rex events -s "$REX_SESSION" --json | grep program_status`.

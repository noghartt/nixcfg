# Changelog

All notable changes to this nixcfg are tracked here, newest first.
Date-based entries with [Keep a Changelog](https://keepachangelog.com/)
categories (Added / Changed / Fixed / Removed) — dotfiles don't semver.
Add user-facing changes under `[Unreleased]`; move them to a dated header
whenever it feels like a checkpoint.

## [Unreleased]

### Added

- **mellon**: `reboot-windows` reboots once into Windows Boot Manager through the firmware
  (`efibootmgr --bootnext`), keeping BitLocker's measured boot path unchanged; INSTALL.md
  documents the matching `bcdedit` one-shot for rebooting from Windows back to Linux.

- **home/noghartt/omo**: `cloud-mode` extension. `omo --cloud <host[:path]>` or
  `/cloud <host[:path]> | off` keeps OmO on this machine but makes the model's environment a
  remote host: read/write/edit/grep and bash (including eval's `tool.*` helpers, background
  sessions, and `!` commands) run there over SSH, local-only tools are switched off, and a
  target that cannot be reached blocks tools instead of falling back to local. The target
  survives resume and reaches subagents.

- **mellon**: always-on agent host groundwork. Key-only hardened sshd reachable only over the
  tailnet, with authorized keys from 1Password (opnix) and a `~/.ssh/rc` that keeps a forwarded
  agent usable from long-lived tmux/Herdr shells; Nix `min-free`/`max-free` GC guards; the
  CUDA binary cache; Docker published ports bound to loopback; Proton-GE; RTL8922AE driver
  power saving off; and OmO itself (x86_64 release binary via nix-ld, each session capped by a
  systemd user scope, user lingering).

- **home/noghartt/omo**: memory guards after one monobloco session's omo reached 20 GB.
  `models.json` caps stored images at 1568px / 750 KB for every catalog and chain model
  (Retina screenshots were kept at ~4.5 MB each and re-sent every turn); JavaScript eval
  kernels run as child processes with a 4 GB recycle ceiling and 30-minute idle parking, so
  browser/screenshot memory is returned instead of staying in omo; and the `omo-memwatch`
  launchd agent snapshots (footprint, vmmap, cwd, newest session) and notifies above 4 GB,
  then stops the process above 12 GB. Snapshots land in `~/Library/Logs/omo-memwatch/`.
- **home/noghartt/swarm**: agent swarms. `/leader <goal>` makes the OmO session the leader of
  a swarm of OmO members running in Docker Sandboxes (or on the host with `--local`). Members
  share a board (discoveries, questions, claims, permissions, skills), work in parallel on
  distinct parts or evolve across Jev-scored generations, and the leader integrates the result.
  Includes the `swarm` CLI and daemon, the `/swarms` panel, and the sbx kit. See `SWARM.md`.
  `/leader` and `/swarms` are exempt from the palette hiding extension commands from slash
  autocomplete.
- **palantir**: Docker Sandboxes CLI (`sbx`, trusted `docker/tap/sbx` cask) with telemetry off,
  used by the swarm feature. The pinned `brew-src` moves 6.0.13 -> 7.0.8, because the cask's
  `symlink ..., overwrite:` step needs Homebrew >= 7.0.0.
- **home/noghartt/pi**: the statusline sidebar's Limits section shows the account email
  each provider is signed in as, under the provider's name. ChatGPT's comes from the token's
  claims; Claude's from one `api/oauth/profile` request per token. Emails stay in process
  memory, never in the shared limits cache.
- **home/noghartt/pi**: the statusline sidebar gains a Goal section under the session
  title: OmO's `/goal` state, the objective (read from its per-session goal store), and the
  continuation countdown. While the sidebar is shown, those statuses leave the footer line;
  narrow terminals and regular mode keep them in the footer.
- **home/noghartt/pi**: the statusline sidebar gains a Todo section (phase progress, the
  active phase's tasks, and OmO's todo reminder state, replacing the "todos stalled" line)
  and pace words under hot limit bars ("running hot"/"at risk" with the projected time the
  window runs out), adapted from fersilva16/nix-config. While the sidebar is shown, OmO's
  todo widget above the prompt is hidden.
- **home/noghartt/cli**: AI harnesses (Pi, `pi-durable`, OmO, Claude Code, Codex) run with
  `~/.agents/bin` first on PATH, where a `gh` shim refuses posting GitHub comments, reviews,
  and comment-bearing close/reopen through subcommands, REST writes, or GraphQL mutations,
  so the never-comment-on-my-behalf rule is enforced instead of only stated. The interactive
  shell keeps the real `gh`.
- **home/noghartt/pi**: `/agent [omo|orchestrator]` (also `--agent` and the `agents:cycle`
  event) switches a session into orchestrator leader mode and back, restoring the previous model
  and thinking level; the choice survives `/resume`. Every orchestrator-relayed message now
  carries the `[orchestrator]` prefix consistently, and worker and leader system prompts say
  it comes from the user, so steers that arrive mid-task are not ignored as injected text.
- **home/noghartt/omo**: `ui-chrome` extension: OmO's dialogs, pickers, session navigation,
  settings, help/hotkeys/session panels, and multi-line notifications open as centred modals over
  a faded backdrop; tool calls collapse to compact one-line rows (Ctrl+O expands); user
  messages, thinking, shell runs, summaries, code blocks, notices, and subagent/`/btw` widgets
  are drawn as cards. It hooks OmO internals and falls back to stock rendering if one moves.
- **home/noghartt/omo**: `ui-prompt` extension: an opencode-style prompt card with an
  `agent · model provider · thinking` line and the working status, ask-user questions drawn
  inside the prompt (no typing while one waits; esc returns the prompt), `Ctrl+X` chords (`L`
  resume, `A` cycle agent, `Y` copy) and `Tab` on an empty prompt to cycle between OmO and
  orchestrator mode, a terminal title with the session name and a busy dot, a per-turn
  `▣ agent · model · duration` footer, and a blinking bar cursor.
- **home/noghartt/pi**: `herdr-fork` extension for Pi and OmO: inside Herdr, `/fork` opens the
  fork in a new focused pane split from the current one, with the forked message prefilled, while
  the original pane stays on its session.
- **home/noghartt/omo**: `findings-cache` extension: explore/librarian subagent results are saved
  in the repository's git common dir, so every worktree (including orchestrator workers) sees
  prior research as a "Cached research" index of leads instead of re-exploring; unused findings
  expire after 14 days.
- **home/noghartt/omo**: OmO-only extension packages are discovered from
  `features/omo/extensions/<name>/` and appended to the packages OmO inherits from Pi.

- **home/noghartt/pi**: Jev gates orchestrator workers per acceptance criterion against
  evidence the orchestrator gathers (changed files, diff stat, commits, and the worker's tool
  calls) instead of one holistic score on the report text. Retries name the failing criteria and
  keep the same model until a repeat miss; borderline results go to the leader as `needs_leader`
  instead of being rejected, and the new `orch_verdict` tool lets the leader accept or reject a
  node over Jev. Replayed against two earlier false rejections, both now pass every criterion,
  while a report contradicted by its evidence still fails.
- **home/noghartt/pi**: inside Herdr, orchestrator workers run as visible, interactive OmO/Pi
  sessions in their worktree workspace's pane (review nodes split the reviewed node's pane), so
  each one can be watched and typed into. The leader drives workers through per-run control and
  event files instead of an RPC stream; outside Herdr they remain hidden RPC children.
- **home/noghartt/pi**: the orchestrator leader runs Opus 5.5 at `xhigh` and plans each goal
  as a dependency graph: nodes start when their `after` dependencies are accepted, can build on
  an upstream node's worktree, and review nodes send `VERDICT: FAIL` findings back to the
  node they review for bounded fix rounds, which the reviewer (not Jev) re-judges. Nodes
  beyond the concurrency limit queue instead of being refused.
- **home/omo**: route the `explore` and `librarian` agents to Claude Sonnet 5.5 (low
  reasoning) with GPT-6 Luna Fast as fallback; the builtin chains fell through to
  Claude Haiku 4.5 for our logins.
- **home/noghartt/herdr**: `Alt+R` opens lazygit in a Herdr popup at the focused pane's
  cwd, so it lands in the worktree being worked on.
- **home/noghartt/herdr**: `Prefix Alt+D` closes every open worktree workspace of the
  focused repository after a confirmation popup, keeping the checkouts or removing them
  (dirty checkouts are kept); the primary workspace stays open.
- **home/noghartt/pi**: the statusline sidebar shows a tokens-per-turn sparkline under
  Session and a "Claude plan" section with meters for the 5-hour, weekly, and per-model weekly
  limits (with time to reset) plus extra-usage spend, read from the Claude subscription usage
  endpoint every 5 minutes and after agent turns.
- **home/noghartt/pi**: `statusline` extension for Pi and OmO: an OpenCode-style fixed right
  sidebar column with the session title, context usage and cost, session token totals, turns
  and duration, an agent tree of the main agent, its `task` subagents, and orchestrator
  workers, the files edited this session with their `+/-` diff against `HEAD`, and git state
  (branch, upstream, ahead/behind, staged/modified/untracked counts) plus harness version;
  OmO's "OmO Native" footer badge is dropped. Pi and OmO now default to the fullscreen TUI,
  which the column needs. Below 120 columns, in regular mode, or toggled off with
  `Ctrl+Shift+B` / `/sidebar`, the footer shows the same information on one line.
- **home/noghartt/cua**: Cua Driver 0.33.1 on palantir for background computer use from Pi,
  Claude Code, and Codex: the notarized app is pinned and copied to `/Applications`, a launchd
  agent keeps its daemon running, and the upstream `cua-driver` skill is pinned to the same tag.
  Claude Code and Codex also get Cua's read-only docs MCP. OmO skips the skill in favor of its
  native `computer` tool; Cua telemetry and self-updates are disabled.
- **home/noghartt/pi**: `orchestrator` extension and `orch` launcher: a leader (Opus 5.5
  by default) spawns worker agents that coordinate through a message hub and shared board,
  while Jev picks the execution strategy and each worker's model (Anthropic or GPT) and gates
  results, retrying on a stronger model when acceptance criteria are not met. Worker worktrees
  are Herdr-managed under `~/.herdr/worktrees/<repo>/` instead of next to the repo. OmO loads it too;
  `TYPESAFE_API_KEY` is resolved from 1Password at shell startup.
- **home/noghartt/pi**: `pi-durable`, the experimental Pi Durable coding agent, packaged
  from the same Pi source and run from TypeScript on Node 24; it shares Pi's auth and settings
  and keeps sessions under `~/.pi/agent/experimental/durable-sessions/`.
- **home/omo**: add OmO Native (`omo`) on palantir as a pinned release binary, with its
  agent dir pinned to `~/.omo/agent` so it stays isolated from the Pi config.
- **home/omo**: generate `~/.omo/omo.jsonc` with agent and category model chains that end
  in a same-tier model from the other provider, so OmO's runtime fallback survives a
  provider-wide outage.
- **palantir**: install `fswatch` for filesystem change monitoring.
- **home/herdr**: add the `Alt+P` pull-request tree plugin, grouped by repository with
  `gh` pagination, search, refresh, Enter to open in the default browser, and `y` to copy URLs.
- **home/herdr**: show independent review and CI status badges with terminal colors,
  searchable text, persistent draft markers, and compact labels for narrow popups.

### Changed

- **home/noghartt/cli**: `~/.ssh/authorized_keys` is no longer written by opnix from a
  `ssh-authorized-keys` vault item; it is kept by hand. A missing item made opnix fail all of
  Home Manager activation, so the git identity and shell secrets were never written.

- **mellon/disk**: Mellon now shares its NVMe with an existing Windows install. disko no
  longer partitions a drive: `INSTALL.md` adds the `disk-main-ESP` (2G) and `disk-main-lvm`
  partitions in Windows' free space with sgdisk, and disko only formats and mounts those, so
  Windows is never touched and any drive works without a repository change. The LVM gains a
  300G `agents` LV at `/agent` for agent sandboxes; the 64G hibernation swapfile is replaced by
  zram; the hardware clock follows Windows' local time. The runbook adds Windows prep
  (BitLocker key, Fast Startup) and booting Windows via `efibootmgr --bootnext`, and installs
  from `main` instead of the stale `v2` branch.
- **home/noghartt/omo**: OmO 5.1.13 -> 5.1.28 (senpi 2026.10.10-10), on the host and in swarm pods: memory-lock churn and
  empty-journal fixes, process-isolated JS kernels available, Haiku 5.5 in the builtin
  explore/librarian/quick lineups (still overridden here).
- **home/noghartt/cli**: Codex 0.156.1 -> 0.162.0 and Claude Code 2.1.280 -> 2.1.295.
- **home/noghartt/herdr**: Herdr 0.9.1 -> 0.9.3: much lower server CPU with many panes, file-based
  image transfer to Ghostty, multiple prefix keys, self-reported agent resume; 0.9.3 fixes
  Escape-prefixed shortcuts (Option+arrows) in panes. The removed pane graphics API is unused here.
- **home/noghartt/pi**: orchestrator workers no longer ask before writing, editing, or
  `rm`-ing files inside their own run-created worktree (exported to them as `ORCH_WORKTREE`),
  even over uncommitted or untracked content or outside the worker's subdirectory. The
  worktree root, its `.git`, and sensitive paths such as `.env` still ask.
- **home/noghartt/omo**: OmO starts on Claude Opus 5.5 at high thinking, with Sonnet 5.5 as
  the lighter Claude option. Claude Haiku 4.5 is gone from OmO's and Pi's model lists, from
  OmO's `quick` chain (now GPT-6 Luna Fast, then Sonnet 5.5), and from the orchestrator's
  worker pool.
- **home/noghartt/pi**: the statusline's "Claude plan" section becomes "Limits": one shared,
  lock-guarded cache in `$TMPDIR` so all Pi/OmO processes make a single usage fetch per 5
  minutes (many orchestrator panes polled separately and drew HTTP 429s), ChatGPT limits
  alongside Claude, pooled Claude accounts, read-only token reads that never refresh, and a pace
  tick per bar that turns it amber when usage outruns an even burn. OmO's capped todo reminder
  shows as "todos stalled" under Agents.
- **home/noghartt/pi**: Pi and OmO start quietly (no startup header or resource listing),
  condense the post-update changelog, and restore the previous screen on exit with only the
  resume hint; OmO's rotating tips are off.
- **home/noghartt/cli**: `.omo/` (OmO's per-project scratch state) is git-ignored globally.
- **home/noghartt/pi**: the destructive guard approves from session context instead of
  prompting on every match, after Claude Code's auto-mode security monitor. It hard-blocks
  self-harm (stopping the agent or its parents, touching `~/.pi`, `~/.omo`, `~/.claude`, or
  credentials, wiping `$HOME`), auto-allows deletions confined to temp directories or files the
  session created, kills of processes the session started, and overwrites Git can restore, and
  asks Jev whether the user named the step or it only touches disposable state before asking you.
  Orchestrator workers' approval dialogs now reach the leader's UI instead of hanging.
- **home/omo**: bump OmO to 5.1.13. `deep-low` now leads with `gpt-6.1-sol` and `deep-high`
  runs at `high`, following the new builtin chains; the new `opencode-routing-notice`
  migration is pre-recorded so OmO does not try to rewrite the read-only `omo.jsonc`.
- **overlays**: Pi moves to 1.0.1 through `overlays/pi.nix`, ahead of nixpkgs (0.85.1 on
  Darwin, 1.0.0 on master); drop the override once the lock catches up.
- **home/noghartt/pi**: the session tree handles Pi 1.0's `context_edit` entries and
  previews entry types it does not know yet instead of rendering nothing.
- **home/noghartt/pi**: the command palette opens with `Ctrl+P` (Herdr owns `Alt+P`) and
  lists built-in commands such as `/tree`, `/model`, and `/resume` beside extension commands,
  prompts, and skills, OpenCode-style. Model cycling moves to `Shift+Ctrl+P`.
- **home/noghartt/pi**: `Ctrl+T` opens the session tree view. Pi's thinking-block toggle
  leaves `Ctrl+T` and becomes a `toggle-thinking` action in the command palette.
- **home/noghartt/desktop**: Ghostty sends left Option as Alt (`macos-option-as-alt = left`),
  so Pi/OmO Alt bindings such as `Alt+E`, `Alt+B`/`Alt+F`, and `Alt+D` work instead of
  typing macOS characters; the per-key `Alt+A`/`Alt+P`/`Alt+T` CSI-u workarounds are gone.
- **home/noghartt/pi**: `Ctrl+?` opens a searchable keybindings modal grouped by action;
  Ghostty sends it as CSI-u because legacy terminals encode it as Backspace.
- **home/noghartt/pi**: the command palette leaves out skills (still reachable through
  `/skill:` autocomplete), cutting OmO's list from 98 to 71 entries.
- **home/herdr**: stop resuming agent conversations after a Herdr server restart
  (`session.resume_agents_on_restore = false`).

### Fixed

- **home/noghartt/swarm**: `--local` members run as tabs of a `swarm <id>` Herdr workspace
  instead of a host tmux server, so they are visible next to every other agent and attach
  focuses their tab. Under tmux they inherited the leader's `HERDR_PANE_ID` and kept reporting
  status for a pane that no longer existed (one stale swarm sent ~17k failing requests in two
  hours). The swarm wrapper no longer pulls in tmux; sbx pods still use tmux inside the pod.
- **home/noghartt/omo**: starting `omo` no longer makes every other running OmO session
  hot-reload (a full-screen redraw and transcript rebuild). The launcher's jq rewrite of
  `settings.json` added a trailing newline, and OmO treats a byte change that touches no keys
  as a real config change. It now writes like OmO does and only when the bytes differ.
- **home/noghartt/swarm**: members keep the board after a daemon restart. `swarm serve`
  reclaims the previous board port and token from `daemon.json`, which members and pod network
  policies were set up with; before, every restart picked a fresh random port and token, and
  running members got connection failures until they were restarted. When the old port is
  taken, the leader is told which members to `swarm_restart`. A pod that fails because sbx's
  global network policy was never initialized now says to run `sbx policy init balanced`.
- **home/noghartt/omo**: new OmO sessions start on Opus 5.5 at `high` again. OmO saves every
  model pick and thinking change as the global default, so the last session's switch (Fable,
  then Sonnet) became every new session's starting model until the next activation. The `omo`
  launcher now restores the startup model before each start; resumed sessions keep their own
  model and `--model` still wins.
- **home/noghartt/pi**: `/reload` no longer kills OmO with "stale extension generation
  after reload". The statusline footer's dispose emitted on the retired generation's event bus,
  which threw before the sidebar was detached and aborted the reload; the old column then
  rendered through the retired API on the next frame. Disposal now cleans up first, a shut-down
  generation never re-attaches its column, a later generation unwraps a leftover one instead of
  nesting it, and render and git refresh ignore stale-context errors.
- **home/noghartt/omo**: inside Herdr, OmO names its tab after the session (session name or
  first prompt), since Herdr ignores pane terminal titles for tab labels. Only tabs still on
  Herdr's generated numeric label are claimed, so manual names and a tab another pane's session
  already named stay; the original label returns when the session ends.
- **home/noghartt/pi**: inside Herdr, an orchestrator leader running in a linked worktree
  workspace can spawn workers: their worktrees are created from the repo's main checkout
  (Herdr rejected the linked one) and branch from the leader's commit, not the main
  checkout's HEAD.
- **home/omo**: OmO's `settings.json` packages and skills, and its `keybindings.json`, now
  follow Pi's on every activation; they had been frozen as store paths when OmO adopted
  Pi's config, which would break once those generations were garbage-collected.
- **home/herdr**: keep the PR tree bundle out of the merged Home Manager profile
  to prevent its `herdr-plugin.toml` from colliding with reviewr's manifest.

### Removed

- **mellon**: hibernation (resume device, the pending `resume_offset` step) and NVIDIA
  suspend VRAM preservation; system sleep is now refused so Mellon runs 24/7.
- **home/noghartt/herdr**: drop the reviewr plugin in favor of the lazygit popup on
  `Alt+R`; activation unlinks its stale registration.
- **home/noghartt/pi**: drop the `pi-claude-bridge` package and its config; Pi's
  Claude models now use the native `anthropic` provider (`/login anthropic`). Under
  OmO the bridge's Claude Code query is aborted at every tool call, so sessions that
  inherited it failed with "Model returned an empty response twice".

## [2026-09-23]

### Added

- **home/noghartt/herdr**: `Alt+A` opens a searchable agent tree popup grouped by
  workspace and linked worktree, with live status, folding, and Enter to focus.
- **home/noghartt/cli**: resolve `TELEPATIA_LITELLM_API_KEY` from its 1Password
  reference into interactive zsh environments through opnix.
- **palantir**: install the Todoist CLI alongside the desktop app.

### Changed

- **flake**: update Herdr from 0.8.2 to 0.9.1, including remote-machine CLI
  control, terminal input fixes, and improved agent status detection.
- **repo**: allow work directly in the checkout and ignore `.worktrees/`.
- **flake**: record the pending Darwin and userspace input refresh, including
  Home Manager's OpenCode service PATH fixes, Noctalia's screenshot annotation
  and enterprise Wi-Fi support, and updated Firefox and VS Code extensions.
- **home/noghartt/cli**: update Claude Code from 2.1.261 to 2.1.280 on
  Apple Silicon and Linux, using Anthropic's native release checksums.
- **palantir**: Ghostty launches Herdr directly. Tmux and Pi's tmux helpers are
  now opt-in imports on Mellon instead of part of the portable baseline.
- **home/noghartt/cli**: update Codex from 0.153.2 to 0.156.1 on Linux and
  Apple Silicon, including the matching Code Mode companion binary.

### Fixed

- **mellon**: retain the committed `nixpkgs-hardware` pin so Linux 7.1 remains
  available; the pending hardware-input refresh removed that kernel.

## [2026-09-08]

### Changed

- **home/noghartt/cli**: pin Codex 0.153.2 from OpenAI's native Linux and
  Apple Silicon release artifacts while nixpkgs remains on 0.149.0, bundling
  the codex-code-mode-host companion binary Code Mode spawns at runtime.
- **home/noghartt/cli**: pin Claude Code 2.1.261 directly from Anthropic's
  native release, following upstream's switch to zstd-compressed binaries.
- **flake**: refreshed Darwin, Home Manager, desktop, secrets, and Mellon's
  independently pinned hardware-stack inputs.

### Fixed

- **mellon**: migrate journald retention limits to `services.journald.settings.Journal`;
  nixpkgs removed `extraConfig`, which broke evaluation after the input bump.
- **home/noghartt/pi**: the command palette accepts both `Super+P` and `Alt+P`;
  Ghostty translates `Cmd+P` to explicit CSI-u `Alt+P`, avoiding ambiguous
  legacy escape sequences and Super-modifier loss through tmux.
- **home/noghartt/pi**: palette selections dispatch as slash commands instead of
  reaching the model as chat text (which produced "Unknown command" replies from
  the claude-bridge backend). On Pi ≥ 0.84.2 they run directly via
  `sendUserMessage` with `expandPromptTemplates`; on older Pi the editor is
  prefilled so Enter submits through the normal command path.

### Added

- **palantir**: install Beancount and its Fava web interface through Home Manager.
- **home/noghartt/herdr**: package and register the release-pinned reviewr plugin
  on Linux and macOS, while keeping its runtime configuration writable.
- **home/noghartt/pi**: install the release-pinned pi-workflows extension and
  its bundled workflow-authoring and automation skills.
- **home/noghartt/herdr**: Herdr v0.8.2 from its official Nix flake on every
  host, configured through Home Manager's native module, with its matching
  control skill exposed to Pi.
- **palantir**: Zotero as a Homebrew cask.
- **palantir**: install the `cloudflared` CLI through Home Manager.
- **palantir**: Todoist as a Homebrew cask (`todoist-app`), since nixpkgs'
  `todoist-electron` package is Linux-only.
- **palantir**: Discord as a Homebrew cask.
- **home/noghartt**: `$NIXCFG` points at the writable checkout and the `nixcfg`
  shell alias changes to it.
- **home/noghartt/cli**: install the FFF terminal file manager alongside fzf.
- **home/noghartt/cli**: install the `ngrok` tunnel CLI on every host.
- **home/noghartt/cli**: tmux `prefix+F` opens an fzf popup over every live
  pane's scrollback and jumps to the selected line in copy mode.
- **home/noghartt/pi**: tmux `prefix+i` opens Pi at the checkout root, while
  `prefix+P` opens an fzf popup that searches sessions in the current checkout
  or every checkout, supports transcript search and previews, and resumes the
  selection in a correctly rooted window.
- **home/noghartt/pi**: a Nix-packaged destructive-action guard prompts before
  dangerous shell commands, destructive custom tools, existing-file
  overwrites, sensitive-path changes, and writes outside the active project;
  non-interactive sessions fail closed.
- **home/noghartt/pi**: `worktree_agents` delegates independent implementation
  tasks to parallel Pi processes in separate Git worktrees by default, supports
  monorepo-relative working directories, and allows an explicit current-checkout
  opt-out for tasks that do not need isolation.
- **home/noghartt/pi**: `Cmd+P` opens a centered, searchable command palette
  with commands grouped by kind and scope; extension commands are removed from
  slash autocomplete to keep prompts and skills distinct from harness actions.
- **home/noghartt/pi**: the command palette's `tree-view` action opens a centered,
  responsive undo-tree modal where linear history stays centered and real
  branches fan into balanced left/right ASCII lanes; a Telescope-style side
  panel previews the selected node's wrapped content, with independent scrolling.
  Search, filters, folding, labels, copy, and branch summaries are retained.
- **palantir**: the existing Obsidian desktop feature (`programs.obsidian`)
  is now imported by the palantir HM entrypoint; it was previously
  mellon-only via `desktop/default.nix`.
- **palantir**: Cloudflare WARP as a Homebrew cask, matching mellon's
  `services.cloudflare-warp`.
- **palantir**: Granola as a Homebrew cask.
- **palantir**: Spotify as a Homebrew cask — the nixpkgs package is unfree
  and thus never binary-cached (full re-download on every bump), and the
  store copy blocks its self-updater. Built-in
  Night Shift covers blue-light filtering (configured in System Settings —
  not declaratively reachable).
- **palantir**: `tailscale` shell alias to the app-bundled CLI — the GUI cask
  links no binary onto PATH.
- **palantir**: OrbStack as a Homebrew cask for Docker + Compose — Apple's
  native `container` 1.0 has no Docker API/compose support yet, so it can't
  replace it.
- **palantir**: Tailscale as a Homebrew cask (`tailscale-app` — the GUI app
  cask, renamed upstream from `tailscale`).
- **home/noghartt/vscode**: VS Code as a standalone HM feature (adapted from
  fersilva16/nix-config): Marketplace extensions via the new
  `nix-vscode-extensions` input, a mutable extensions dir with a
  `vscode-sync-extensions` snapshot script, and settings.json symlinked
  out-of-store into the repo so UI edits persist. Imported on palantir.
- **home/noghartt/cli**: gh clones over SSH (`git_protocol = "ssh"`), routed
  through the 1Password SSH agent.

### Fixed

- **home/noghartt/cli**: follow Pi's recommended tmux CSI-u setup so Shift+Enter,
  Ctrl+Enter, and Option+Enter remain distinguishable from Enter.
- **home/noghartt/cli**: define the custom tmux status bar before Continuum loads
  so its ten-minute Resurrect autosave hook is no longer overwritten.
- **home/noghartt/pi**: update `pi-claude-bridge` to 0.6.3 so its model catalog
  includes Claude Fable 5, Sonnet 5, and Opus 5; Fable and Sonnet now request
  their 1M-context variants.
- **home/noghartt/cli**: tmux now establishes zsh as its early default shell
  and lets Resurrect use disposable session `0` while restoring the first
  server, preventing both `/bin/sh` panes and Ghostty's initial window closing.
- **home/noghartt/cli**: Claude's global `settings.json` is now a writable
  runtime file. Home Manager activation refreshes Nix-owned top-level keys
  while preserving keys injected by setup tools, including Warcamp hooks.
- **config/neovim**: `lazy-lock.json` is now an out-of-store symlink into the
  repo checkout — Lazy rewrites it on install/update, which "Permission
  denied"-failed against the store-managed copy.
- **flake**: `brew-src` overridden to Homebrew 6.0.13 — nix-homebrew's own
  pin (6.0.12) predates the cask `run` install step served by the live
  formulae API, breaking `orbstack` install with "unknown install step: run".
  Drop the override once upstream catches up.

- **home/noghartt/pi**: the custom `pi-claude-bridge` npm package and its model
  entries are available on Darwin again — the `prefetch-npm-deps` build failure
  that had them temporarily Linux-gated is fixed on the current
  `nixpkgs-darwin` pin, so the gate is removed.

### Changed

- **home/noghartt/cli**: disable Claude Code's OS sandbox because it interfered
  with automatic permission mode; Bash and subagents now run unsandboxed.
- **palantir**: interface language forced to English (`AppleLanguages`
  en-US-first with pt-BR fallback, `AppleLocale` en_US) via freeform defaults.
- **lib**: Darwin hosts now default `computerName` and `localHostName` (the
  user-facing and Bonjour names) to the host directory name, alongside the
  existing `hostName` default.
- **home/noghartt/cli**: git identity now reads two plain `name`/`email` fields
  from the 1Password `git` item instead of an ini blob in its notes; a Home
  Manager activation step after opnix retrieval composes the git include file.
- **flake/lib**: Darwin hosts are directory-discovered from the same `hosts/`
  tree as NixOS — a `*-darwin` `nixpkgs.hostPlatform` in the spec routes the
  host to `mkDarwinConfig`. They use a dedicated `nixpkgs-unstable` input,
  share the host-spec contract with NixOS, and receive platform-matched flake
  build checks.
- **home/noghartt**: the user factory now supports both NixOS and nix-darwin,
  imports the same portable HM baseline on both, and keeps Home Manager's string
  state version independent from nix-darwin's integer state version.
- **flake/lib**: hosts now declare their own platform via `nixpkgs.hostPlatform`
  instead of a hardcoded `x86_64-linux` in `mkNixOSConfig`; per-system outputs
  (checks, devShells, formatter) are generated for x86_64-linux, aarch64-linux,
  and aarch64-darwin, with each host's build check filed under its own platform.

### Added

- **hosts/common/darwin**: declarative Homebrew — the `nix-homebrew` input owns
  a pinned Homebrew installation, while nix-darwin's `homebrew` module drives
  `brew bundle` with auto-update disabled and `zap` cleanup so installed
  casks/formulae never drift from the flake; palantir declares the `1password`,
  `raycast`, and `slack` casks as its first entries.
- **home/noghartt/cli**: the 1Password CLI (`op`) joins the portable baseline,
  complementing the opnix-driven secrets on both hosts.
- **config/neovim**: the existing Lua editor configuration and Lazy
  plugin lockfile are now managed as a portable Home Manager feature shared by
  Mellon and Palantir, with native plugin build dependencies included.
- **palantir**: first nix-darwin host for the M5 work MacBook Pro, with a minimal
  host entrypoint reusing Mellon's Chrome, Firefox, Ghostty, and Claude Code
  configuration through Home Manager, plus a dedicated bootstrap runbook.
- **mellon**: TPM2 measured-boot preparation with PIN-based LUKS unlock and
  passphrase fallback, Steam and GameMode, and lock-before-sleep integration
  between logind and Noctalia.
- **tooling**: revision-labelled generations, immutable source breadcrumbs,
  flake-native formatting and discovered-host build checks, plus the
  `nix-darwin` input and `mkDarwinConfig` foundation.
- **home/noghartt/agents**: Claude Bash and subagents now run in the OS sandbox;
  retrying a command without the sandbox requires explicit approval.
- **home/noghartt**: explicit portable/platform Home Manager composition; Mellon
  directly selects its Wayland modules while shared CLI and desktop modules
  remain available to a future Darwin host. Portable application, Ghostty, and
  Flameshot settings are separated from Mellon's Linux-only packages and UI
  policy.
- **home/noghartt/desktop**: Hyprsunset blue-light filtering for the Wayland
  session, with daytime identity and a warm evening profile.
- **docs**: complete Mellon installation runbook covering installer preparation,
  locked Disko provisioning, LUKS and Lanzaboote bootstrap, 1Password/opnix,
  hibernation, hardware validation, and live-USB recovery.
- **mellon/hardware**: independent nixpkgs lock for Linux 7.1.4, Linux
  firmware, wireless regulatory data, and AMD microcode; NVIDIA 595.84 is
  explicitly pinned with source hashes in the host module. Userspace can now
  update without moving the tested hardware stack.
- **mellon/nvidia**: official `nixos-hardware` Blackwell baseline; redundant
  driver selection and DRM kernel parameters are now delegated upstream.
- **mellon**: LUKS encryption around the existing LVM layout, Lanzaboote
  Secure Boot, bounded root Snapper retention, journal limits, conservative
  Docker pruning, Brazilian Wi-Fi regulatory settings, and disabled Wi-Fi
  power saving for RTL8922AE reliability.
- **tooling**: GitHub Actions now runs every flake check on main/v2 pushes and
  pull requests with commit-pinned actions.
- **mellon**: systemd-resolved, native firewall, Tailscale, Cloudflare WARP,
  Wireshark capture, SMART desktop notifications, weekly trim, power profiles,
  explicit `us-intl` desktop input, and NVIDIA VRAM preservation across
  suspend/hibernate.
- **home/noghartt/desktop**: Noctalia v5 shell with notifications, lock screen,
  and idle handling; rofi launcher, Hyprpolkitagent, complete workspace/window
  bindings, MIME defaults, Todoist, Calibre, Zotero, Slack, Discord, and Spotify.
- **home/noghartt/cli**: Jujutsu.
- **home/noghartt**: Claude Code, Codex, and OpenCode through per-harness Home
  Manager modules; Claude Code's global settings are managed declaratively. Pi
  is an independent feature with Misterio77-inspired model, compaction,
  keybinding, and offline settings plus the Nix-packaged `pi-claude-bridge`.
- **home/noghartt**: tmux now auto-attaches from Ghostty and includes vi copy
  mode, Wayland clipboard integration, persistent sessions, and git-root-aware
  agent and lazygit panes based on fersilva16's setup.

### Removed

- **home/noghartt/cli**: tmux Resurrect and Continuum session snapshots and
  automatic restore; live tmux sessions still persist while the server runs.
- **mellon**: an unpinned latest-kernel selection and unexplained `nowatchdog`;
  Linux is now explicitly selected from the independently locked hardware set.
- **mellon/storage**: global Btrfs `autodefrag`; Docker and large-file workloads
  make its write amplification a poor default alongside timeline snapshots.
- **home/noghartt/desktop**: Dunst; Noctalia now owns desktop notifications.

## 2026-07-22

Initial build-out: flake skeleton plus the full mellon desktop setup.

### Added

- **Flake skeleton**: hosts and users directory-discovered via `lib/mapDir`;
  `mkNixOSConfig` maps host specs (functions of `{ users, lib }` returning
  fields) into `nixosSystem` modules. Option-only custom modules
  (`device.type`) auto-imported into both NixOS and home-manager.
- **User factories** (`home/<user>/user.nix`): overridable, nixpkgs-style
  (functor + `overrideAttrs`) — first production use: mellon adds the
  `docker` group for noghartt.
- **Repo conventions**: AGENTS.md (agent reference), TASK.md (living
  checklist), Misterio77-style commit conventions.
- **mellon (NixOS desktop)**:
  - disko: ESP 2G + LVM (root 500G, home ~1.3T), btrfs subvolumes
    `@ @nix @var_log @snapshots @swap` + `@home`, 64G swapfile sized for
    hibernation (resume_offset pending install day).
  - NVIDIA RTX 5070 Ti (Blackwell): open kernel module + modesetting,
    adapted from fersilva16/nix-config.
  - `linuxPackages_latest` for the RTL8922AE WiFi (Blackwell suspend
    caveat documented), systemd-boot + systemd initrd + LVM.
  - Wayland desktop: Hyprland, greetd+tuigreet, pipewire, bluetooth.
  - docker with NVIDIA container toolkit; AMD microcode, fwupd, btrfs
    autoscrub.
  - 1Password GUI + SSH agent from the vault, op and opnix CLIs.
- **home/noghartt**:
  - HM structure: `home.nix` default entrypoint + optional per-host
    `<host>.nix` overrides, import-based features.
  - cli: zsh + oh-my-zsh (robbyrussell), tmux (catppuccin bar), git
    settings with gh credential helper, direnv + nix-direnv, neovim,
    eza/bat/fd/fzf/lazygit, docker-compose.
  - desktop: Hyprland HM config, ghostty, dunst, flameshot, obsidian,
    google-chrome.
  - Firefox with the extension set replicated from the old profile:
    9 pinned via rycee `firefox-addons` (new flake input), 3 via browser
    policies (zotero connector unpackaged; 1password and readwise are
    unfree for the addons flake).
  - Secrets via 1Password + opnix (new flake input): git identity read
    from the Nix vault at activation (`programs.onepassword-secrets`),
    secrets-as-env-vars pattern (`secrets-env.nix`) with path-only
    interpolation (`secretPaths`).

### Changed

- Disk layout resized to match real usage: home takes the remainder of the
  VG (~1.3T) instead of 1T + 300G idle; `@snapshots` and `@var_log`
  restored from the Arch install; ESP 1G -> 2G for NixOS generation count.

### Removed

- LUKS from the disk layout (unencrypted by choice; note: hibernation
  image is unencrypted too).
- fish and alacritty in favor of zsh and ghostty.
- `claude-mem` and `zotero-cli` aliases (dropped by user).

### Decisions worth remembering

- **systemd-boot, not EFISTUB**: NixOS has no native EFISTUB module;
  per-generation `efibootmgr` scripting would be fragile.
- **eza, not exa**: exa is unmaintained since 2023.
- **1Password over sops-nix** for secrets: vault already holds everything;
  SSH keys stay in the vault (agent), small secrets via opnix.
- **No PII in the repo**: git identity comes from 1Password, never from
  tracked files.

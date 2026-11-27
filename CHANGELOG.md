# Changelog

All notable changes to this nixcfg are tracked here, newest first.
Date-based entries with [Keep a Changelog](https://keepachangelog.com/)
categories (Added / Changed / Fixed / Removed) — dotfiles don't semver.
Add user-facing changes under `[Unreleased]`; move them to a dated header
whenever it feels like a checkpoint.

## [Unreleased]

### Added

- **home/noghartt/sandbox**: `sbx`, sandboxes behind a provider interface (capabilities, reusable
  contract tests) with exe.dev as the first provider on the official `@exedev/sdk`. VM kinds set
  egress, size, integrations and setup (`dev`, `agent` with no public internet, `job` for one-off
  compute via `sbx run`); templates copied with `cp` for fast starts; repos seeded and pushed
  through exe.dev's GitHub integration (no tokens on VMs), branches pulled back as `sbx/<name>/*`;
  tag-scoped API token; hourly reaper archives branches before removing idle VMs. Never creates
  metered standalone VMs (`docs/sandbox.md`).
- **home/noghartt/pi-durable**: `/accounts` manages logins from inside a session. Bare, it lists every
  login by provider (Claude with its fallback accounts, then each provider in the agent dir's `auth.json`):
  signed in or not, email, and for pooled Claude accounts the block and which is active. `/accounts add
  <name>` signs an extra Claude account in through pi's login dialog (URL, pasted code), `/accounts login
  <provider>` signs the agent dir in to any provider pi offers OAuth for (its models join `/model`), and
  `/accounts remove <name>` deletes an extra account after a confirmation; all complete their arguments.
  Added and removed accounts take effect in the open session (the account pool is always there and
  reloads), also accounts added from a shell, once `/accounts` or `/status` runs. The sign-in, order and
  removal code is shared with `pi-durable accounts`, and the package's install check now runs tests
  (`features/pi-durable/tests/`).
- **home/noghartt/pi-durable**: an `agency` system-prompt section: the agent takes the clear next step
  (watch a PR's CI and fix failures, run tests after a change, act on watcher reports) instead of ending
  on "Should I ...?"; it still asks before destructive or hard-to-undo actions and on open decisions.
- **home/noghartt/pi-durable**: Claude multi-account fallback. `pi-durable accounts login <name>` signs
  extra Claude accounts in (each with its own `accounts/<name>/auth.json` and token refresh), `accounts
  list` / `remove` manage them. A request that hits a usage limit before any content streamed continues on
  the next account, and requests return to `main` once its window resets; blocks are shared across
  processes in `accounts/state.json`. Switches show a notice, the footer shows the active account and
  `/status` lists them; with one account nothing changes. The statusline's limits also read the extra accounts.
- **home/noghartt/pi-durable**: `/btw <question>` asks a quick side question about the shown
  conversation while the agent keeps working: one tool-less request on the conversation's model, streamed
  into a panel, never written to the transcript. `/status` shows Claude/ChatGPT subscription limits (via
  the statusline's shared cache), today's spend and tokens across every session by model, and session counts.
- **home/noghartt/cli**: `pr-babysit` skill for Claude Code, Codex and Pi (`cli/agents/skills/`).
  Run after opening a PR (ideally as a background subagent): it waits on CI, fixes failing checks and
  actionable review threads, handles conflicts, pushes, and drafts replies for the user to post (the `gh`
  shim still blocks posting), until the PR is green and quiet.
- **home/noghartt/pi-durable**: deep research (`docs/deep-research.md`). `/research <question>` runs the
  `research` skill: the conversation plans angles, fans out `researcher` subagents, has `research-critic`
  review their notes, and writes a cited report with an annotated reading list to
  `~/research/<date>-<slug>/`. New tools: `web_search` (Exa, Kagi), `web_fetch` (Exa reader, plain
  fetch, headless Chrome with no window, Wayback Machine, Kagi summarizer; cached 30 days), `lookup`
  (Wikipedia, OpenAlex, arXiv, Hacker News, GitHub), `research_note` (the researchers' only way to write) and
  `research_verify` (checks note quotes against their pages). Researchers get no shell or file tools, since
  they read untrusted pages. `EXA_API_KEY` comes from 1Password through `secrets-env.nix`; `KAGI_API_KEY` waits for its item.
- **home/noghartt/pi-durable**: `/swarm <task>`, modelled on Antigravity's `/swarm`. The conversation
  becomes a coordinator that adds workers (profiles, optional worktrees, sharded tasks). They
  collaborate on a durable board where `@mentions` wake agents and waiting costs nothing. A
  plain-code monitor alerts the coordinator when the swarm stalls. `/swarm board` shows the overview,
  roster and posts, and `/swarm end` stops the swarm.

### Removed

- **mellon**: agentbox (systemd-nspawn sandboxes, root daemon, net profiles, `sandbox.internal` DNS
  and tailnet route, opnix sandbox env catalog) and its `checks.x86_64-linux.agentbox` VM test.
- **home/noghartt**: exebox (exe.dev sandboxes) on Palantir and Mithril, replaced by `sbx`.
- **home/noghartt/omo**: cloud-mode's `--sandbox`/`--env`/`--net`/`--size`, the `local` and `exe`
  targets, subagent sandboxes and `handoff`; legacy sandbox sessions are blocked until re-targeted.
  Plain `omo --cloud <host[:path]>` and `publish` (now `cloud/<host>/<branch>`) remain; children keep
  their own tool limits and only the top session publishes.
- **home/noghartt/pi**: orchestrator sandbox placement (`workers.*`, `sandbox.ts`); isolated nodes use
  worktrees, a cloud-mode leader's nodes need isolation `current`. destructive-guard's sandbox skip
  and `aeval replay --sandbox` (now rejected) are gone too.
- **overlays**: `overlays/pi.nix`. `pi-durable` moved to its own feature (see Changed).
- **home/noghartt/leverage**: Leverage Computer CLI on Palantir. Upstream serves only a moving
  `stable` download, so each release broke the pinned build. `~/.config/leverage` is left in place.
- **home/noghartt/omo**: OmO no longer loads Pi's command palette, session tree, orchestrator
  or agent-forum client; Pi keeps all four.

### Changed

- **home/noghartt/pi-durable**: the `codex-reviewer` and `research-critic` profiles run on
  GPT-6.2 Astra (`openai-codex/gpt-6.2-astra`) instead of GPT-6 Astra.
- **home/noghartt/pi-durable**: `/swarm` members run on models other than the coordinator's.
  `swarm add` now requires a profile. The coordinator's guide names its own model, sends mechanical
  parts to cheap implementers and judgment calls to strong ones, and gives verifiers a different
  model family from their authors. `add` takes a per-member `thinking` level (on agy, the model's
  `-low`/`-medium`/`-high` variant). Antigravity profiles now join as board members: each post that
  mentions one runs agy (continuing one agy conversation) with every post it has not seen, and
  agy's answer is posted as its reply.
- **home/noghartt/pi-durable**: `/fork` is now `/tree` filtered to user messages instead of a flat
  message list, and both open under an overview of the session's branches (where each forked, what it
  added, how it starts, which one is shown).
- **home/noghartt/pi-durable**: `pi-durable` (1.0.1 -> 1.6.0) is a standalone feature instead of an
  overlay, still built against the nixpkgs Pi package's own modules. It now loads skills, prompt
  templates and AGENTS.md through Pi's resource loader, so a repository's `.agents/skills` are
  found as in `pi`, following Pi's project trust. Typing `/` lists Pi's commands, templates and
  `/skill:<name>`; `@` completes paths. `/tree`, `/fork` and `/clone` branch on Durable forks
  inside one session, shown with Pi's tree selector. `/new`, `/resume` (Pi's session picker),
  `/name`, `/session`, `/copy`, `/thinking`, `/reload` and `/trust` are new. Sessions reopen on
  the branch last shown, and empty sessions are not kept. 1.0.1 sessions in `~/.pi/agent` are
  not opened.
- **home/noghartt/pi-next**: `pi` starts from an empty, hand-managed agent dir
  (`~/.config/pi/agent`): no extensions, settings or logins carry over. The previous Pi module
  stays only for the values OmO inherits; OmO is unchanged. Old sessions stay
  in `~/.pi/agent`, and `aeval` still reads only that dir.
- **flake**: `nixpkgs-darwin` ea9e3ef -> 619c39f (2026-11-22), which brings Pi 1.6.0 to the Macs.
- **flake**: `nixpkgs` 0bb2eed -> 2786a2a (2026-11-01 -> 2026-11-21), which brings Pi 1.6.0 (from
  1.4.0) to Mellon. `nixpkgs-hardware` is unchanged.

### Added

- **home/noghartt/pi-durable**: a tool result cut to 2000 lines / 50 KB keeps its complete text in a
  temp file named in an `[info] Full output: <path>` diagnostic, as bash's output already did, so
  long subagent, `parallel`, `agents read` or `antigravity` answers can be paged with `read`. The
  file goes through the conversation's execution environment, ready for remote (cloud) ones.
- **home/noghartt/pi-durable**: subagent profiles per model, shipped by the feature: Opus 5.5 and
  Sonnet 5.5 workers, scout and reviewer; Codex reviewer (GPT-6 Astra) and worker (GPT-5.6 Sol);
  and `runner: antigravity` profiles on Gemini 4 Neon (`gemini` read-only, `gemini-worker`
  writing in its own worktree), run through agy as a nested call.
- **home/noghartt/git-twig**: `git twig` 0.6.0 (built from source, all hosts): linked Git worktrees
  with copy-on-write file clones; its bundled skill is linked into Claude Code, Codex and Pi.
- **home/noghartt/pi-durable**: isolated subagents get their worktrees from `git twig new`
  (`PI_DURABLE_TWIG=0` uses `git worktree add`). Warnings and errors collapse into a `⚠ n` / `✖ n`
  count in the footer; `/notices` shows or hides them and `/notices clear` dismisses them.
- **home/noghartt/pi-durable**: `@session:`, `@agent:` and `@label:` complete in the editor (sessions,
  conversations, labels, and labels after `#`); targets and labels with spaces can be quoted, and a
  trailing backtick or punctuation is no longer read as part of a reference.
- **home/noghartt/pi-durable**, **home/noghartt/pi-next**: Rex integration (`docs/rex.md`): inside a Rex
  terminal, `pi` and pi-durable report working/blocked/done/error with the Program Status Protocol
  (pi-durable also per subagent), and get Rex's session-start context as a `rex` prompt section.
- **home/noghartt**: every worktree creator uses `git twig new` (`docs/git-twig.md`): Pi/OmO's
  `worktree-agents` and orchestrator, Herdr (patched), and Claude Code through `WorktreeCreate`/
  `WorktreeRemove` hooks that keep its layout; pi-durable's prompt steers manual worktrees to twig.
- **home/noghartt/cli**: Cursor's `thermo-nuclear-code-quality-review` skill, pinned, for Claude Code,
  Codex and Pi (`cli/agents/skills.nix`). It is user-invoked only (`disable-model-invocation`).
- **home/noghartt/pi-durable**: agents. Subagent profiles are markdown files (`agents/*.md` in
  the agent dir, `~/.agents/agents`, or a trusted project) with their own model, thinking, tools,
  turn limit and instructions; `general`, `explore`, `reviewer` and `worker` are built in.
  `subagent` waits without holding a process, or runs in the background and reports back;
  `parallel` fans out up to 16 tasks, 4 at a time by default. `worktree` isolation gives a
  subagent its own git branch and checkout. `watch` wakes the agent on a command's exit or
  matching output, file changes, or a timer. `agents` messages, reads and stops this session's
  agents; `sessions` reads and messages other sessions through an inbox. Labels in `/tree` and
  `/label`, `@session:`/`@agent:`/`@label:` references in input, an agents panel with `/stop`,
  and `/dashboard` (also `pi-durable agents`) listing every session by project with its live
  status. All of it survives a restart.
- **home/noghartt/pi-next**: `antigravity` tool that delegates a task to the Antigravity CLI
  (`agy`) as a sub-agent on its Gemini/Claude models. Read-only by default; `allowWrites` asks
  first. Packages in `features/pi-next/extensions/` are linked into `~/.config/pi/agent/extensions/`.
- **palantir**: OpenVPN Connect, from the `openvpn-connect` cask.
- **home/noghartt/omo**: Refuseless GLM 5.3 Abliterated (`refuseless/glm-5.3-abliterated`)
  is a custom OmO provider and is in the model picker: 1M context, 131k output,
  `low`/`high`/`max` thinking only. Its key, `REFUSELESS_API_KEY`, comes from the 1Password
  item `op://Nix/REFUSELESS_API_KEY` (notes field) through `secrets-env.nix`.
- **home/noghartt/omo**: OmO memory is off on every host (`memory.enabled = false` in
  `omo.jsonc`). It kept a memory repo per checkout, so each Herdr worktree created its own.
- **home/noghartt/pi**: Pi and OmO sessions report their idle, working and blocked state
  to Herdr, so they show in its agent list and sidebar. OmO shows as `omo`. Before this, OmO
  panes were missing, or showed as `claude` while a Claude subscription child was in the
  foreground. The extension is Herdr's own Pi integration, built from the pinned Herdr source.
- **home/noghartt/omo**: evaluation warns when the packaged OmO version differs from the one
  `ui-chrome` and `ui-prompt` were checked against (`omoVerified` in their `package.json`), since
  both reach into OmO internals that move between releases.
- **home/noghartt/cli**: DeepSeek Harness (`dsh`) on Palantir, wrapped like the other agent
  harnesses so it gets the `gh` shim. nixpkgs lists the package for Linux only, so the module
  adds aarch64-darwin, where the same recipe builds and runs. The official desktop app comes
  from the `deepseek-harness` cask, on Palantir only (it updates itself).
- **home/noghartt**: hashcards 0.5.0, the plain-text spaced repetition CLI, on Mellon, Palantir,
  and Mithril. It is not in nixpkgs, so `features/hashcards/package.nix` builds it from the
  release tag; to upgrade, bump the version and both hashes there.
- **lib**: `hosts/common/local.nix`, empty `nixos` and `darwin` modules every host imports. Marked
  `git update-index --skip-worktree` on one machine, it holds that machine's private additions:
  git keeps seeing the empty stub while a plain `--flake .#<host>` rebuild reads the edits.
- **overlays**: Claude Desktop (`claude-desktop`, 5.11492.2, Anthropic's Linux beta) on Mellon,
  repackaged from the official .deb in Anthropic's apt repository; the Macs keep the cask. It
  does not update itself on Linux: bump the version and hash in `overlays/claude-desktop.nix`.
  Cowork (QEMU/KVM VMs) is not wired up.
- **overlays**: Cursor's Grok Bot desktop agent (`grok-bot`, 0.78.1) on Mellon, repackaged from
  the vendor's .deb (the only Linux build). It uses native Wayland when `NIXOS_OZONE_WL` is set.
  To upgrade, change the version, the release commit, and the hash in `overlays/grok-bot.nix`.
- **mellon**: Bluetooth settings for AirPods. Blueman and upower show headset battery levels,
  reconnecting after the Mac had the AirPods is quicker, and re-pairing after another system
  replaced the pairing key no longer asks for confirmation.
- **mellon**: downloaded scripts with hardcoded interpreters (`#!/bin/bash`) now run, because
  envfs serves `/bin` and `/usr/bin` from the caller's `PATH`. A Java 21 JDK is installed
  system-wide for GT: New Horizons servers started from a shell.
- **home/noghartt**: Prism Launcher (Minecraft) on Mellon, with nixpkgs' bundled Java runtimes.
  Games it starts use SDL's native Wayland backend: on Niri, SDL fell back to XWayland, where
  NVIDIA could not create an EGL window and GT: New Horizons crashed at startup.
- **mellon/mouse**: the Logitech mouse (Logi Bolt receiver) runs at 3200 DPI. Solaar's user
  daemon runs in the session. Before it starts, `solaar-set-dpi` writes the DPI to the mouse and
  saves it in Solaar's config, and the daemon re-applies it whenever the mouse reconnects or wakes.
- **home/noghartt/desktop**: on Niri, `Mod+S` splits the focused window and the next column
  half and half, and pressing it again makes the focused one full width. `Mod+Shift+S` splits
  into thirds. A new window now fills the ultrawide instead of taking half of it. Tabbed
  columns show a clickable strip across the top with one segment per tab, and the overview
  zooms to 0.6 so it stays readable.
- **mellon/audio**: guitar setup. Guitarix and the qpwgraph patchbay join pavucontrol, and a
  PipeWire JACK rule gives Guitarix a 128-frame quantum (~2.7 ms) while it runs. The user joins
  `audio`, which gets an unlimited memlock limit so Guitarix's `mlockall` succeeds. Guitarix is
  wrapped onto PipeWire's libjack, so it no longer depends on the session's `LD_LIBRARY_PATH`.
- **hosts/common**: the Claude desktop app (`claude` cask) on both MacBooks.
- **home/noghartt/exebox**: exe.dev sandboxes next to agentbox, opt-in on Palantir and Mithril.
  `exebox` gives exe.dev VMs agentbox's command contract (seed and collect as git bundles,
  `--from` children, keep, idle reaping with archives), and `omo --cloud exe --sandbox` runs a
  session's tools in one, subagent sandboxes and `publish` included. exe.dev cannot restrict
  egress, so these sandboxes are always `open`; orchestrator and swarm support come later.

### Fixed

- **home/noghartt/pi**: the statusline's limits fetcher also reads `~/.config/pi/agent/auth.json`
  (pi-next's and pi-durable's agent dir), so a fetch from any process sees that Claude login, not only
  one run with `PI_CODING_AGENT_DIR` set.
- **home/noghartt/pi**: the statusline shows Claude limits again under OmO. OmO now signs
  Claude accounts in through the bundled Claude CLI, which keeps their tokens in its own store
  (the macOS Keychain), so `auth.json` holds no token the limits fetcher could use. Claude
  windows now come from OmO's own usage polling (`pi.getSubscriptionLimits()`), updated live,
  and account emails come from the profiles OmO records. Pi and ChatGPT keep the existing fetcher.
- **home/noghartt/omo**: Opus 5.5 sessions no longer jump to ~209% context and fail with
  "Nothing to compact" while their real context is ~60k. Claude Code loaded the account's
  claude.ai connectors (fal, Docs, Drive, ...) into OmO's SDK subprocess, and their tool schemas
  added ~566k cached tokens to alternating turns. The `omo` launcher now defaults
  `ENABLE_CLAUDEAI_MCP_SERVERS=false`; export `true` to get the connectors back.
- **home/noghartt/omo**: OmO no longer reports "Pre-prompt compaction failed: Nothing to
  compact (session too small)" on young Opus 5.5 and Sonnet 5.5 sessions. The 750k
  `compaction.modelOverrides` reserve left only 250k of the 1M window, so the pre-prompt
  hard-limit check fired before there was anything to compact. The reserve is gone;
  `models.json` instead caps both models' planning `contextWindow` at 300k, which still
  compacts near ~210k while the account keeps 1M. Activation drops the stale key from the live
  `settings.json`.
- **home/noghartt/hashcards**: declares SQLite, which it links against; Palantir's build failed
  with `library not found for -lsqlite3`.
- **home/noghartt/leverage**: bumped to 0.2.293. Upstream's moving `stable` download changed,
  so the pinned hash no longer matched and Palantir's rebuild failed.
- **overlays**: opencode 2.2.5 builds on the Macs again. Its `node_modules` hash in nixpkgs went
  stale when bun moved to 1.4.4 (NixOS/nixpkgs#582673); `overlays/opencode.nix` pins the hash
  measured on aarch64-darwin until nixpkgs changes it.
- **home/noghartt/agent-evals**: the replay test gets a 60 s timeout. It takes about 0.5 s on an
  idle machine, but went past bun's 5 s default while building beside a loaded `darwin-rebuild`.
- **home/noghartt/neovim**: Mason can install eslint, ts_ls, gopls and basedpyright again.
  Node.js, Go and Python 3 are now on Neovim's own PATH, because Mason builds those servers with
  npm, go and a Python venv.
- **home/noghartt/pi**: destructive-guard no longer asks for approval when editing or deleting files in
  a Herdr worktree (`~/.herdr/worktrees/...`) of the session's repository. Every worktree that
  `git worktree list` reports now counts as part of the project; each worktree's root and its `.git` still ask.
- **home/noghartt/cli**: Codex can trust folders again. Cua's docs MCP server made Home
  Manager link `~/.codex/config.toml` into the read-only Nix store, where Codex also keeps
  project trust, plugins, and hook state. Activation now writes a regular file instead, replacing
  only the Nix-owned leaves (tracked in `$XDG_STATE_HOME/nixcfg/codex-config-baseline.json`).
- **overlays**: `codex` starts again. Since 0.162 it runs through a background app-server
  daemon, which installs itself from the CLI's complete release package and refused the bare
  binary the overlay shipped ("this CLI has no complete local package"). The overlay now
  installs `codex-package-<target>.tar.gz` intact under `libexec/codex` and wraps
  `bin/codex` around it.
- **home/noghartt/omo**: new OmO sessions start at `high` again instead of `xhigh`. OmO 5.1.x
  keeps per-model thinking memory in `state.json`, where it outranks `defaultThinkingLevel`, and
  the launcher was still resetting the old `settings.json` key, so one Opus switch to `xhigh`
  (the orchestrator leader) became every session's start. Subagents are capped at `high` too:
  `session-model` lanes that inherit the session's level, every `omo.jsonc` chain (`max` before,
  plus a new `plan-reviewer` override of the builtin `xhigh` chain), and swarm member picks.
  Only the orchestrator and swarm leaders run at `xhigh`.
- **home/noghartt/darwin**: the Rex terminal's `rex` CLI is on PATH on both MacBooks. Rex keeps it
  in its per-account server bundle and prepends that dir when it spawns a shell, but
  nix-darwin's `set-environment` rebuilds PATH from scratch, so `rex skill setup` and the agent
  hooks it installs could not find `rex`.

### Changed

- **home/noghartt/omo**: category subagent spawns are routed by `omo.jsonc` category chains
  (routine lanes on Sonnet 5.5, the rest on Opus 5.5, capped at `high`) instead of the
  `session-model` extension rewriting every `task` call.
- **home/noghartt/pi**: the orchestrator leader judges settled workers itself. Work nodes settle
  as `done_ungated` with the collected evidence attached, reviews decide by their `VERDICT` line,
  and worker models come from the pool default or the leader's explicit pick; placement uses
  the config defaults. Removes a model hop per settled node.
- **AGENTS.md**: feature write-ups moved to `docs/` (one file per feature); AGENTS.md keeps the
  layout, conventions, a feature-docs index, commands, and rules.
- **home/noghartt/cli**: Codex 0.162.0 -> 0.166.0 and Claude Code 2.1.295 -> 2.1.318.
- **home/noghartt/omo**: OmO 5.1.33 -> 5.1.60, on the host and in swarm pods (Claude subscription
  accounts now sign in through Claude Code; sign in again after switching).
- **overlays**: Pi follows nixpkgs again (1.5.0 on the Macs, 1.4.0 on Mellon); `overlays/pi.nix`
  builds only `pi-durable`, pinned at 1.0.1.
- **flake**: every input updated, Mellon's hardware stack included. Linux 7.1 reached end of life
  and left `nixpkgs-hardware`, so Mellon moves to 7.2, and its NVIDIA pin moves from 595.84 to
  595.112.07 because 595.84's open module calls `strncpy`, which 7.2 removed. Lanzaboote 1.2 keeps PCR4 in the Measured Boot policy across bootloader updates,
  which caps the ESP at 4 generations (was 8). NixOS dropped the scripted initrd, so `boot.nix`
  no longer sets `boot.initrd.systemd.enable`. Zotero's Firefox ESR 140 runtime reached end of
  life and is permitted by exact version on Mellon until nixpkgs moves Zotero off it.
- **mellon/desktop**: Niri replaces Hyprland as the only compositor; greetd starts
  `niri-session` directly. `features/desktop/niri.nix` keeps the Noctalia shell, i3 keys, the
  Adwaita cursor and the polkit agent, adds a flat mouse profile and the ultrawide's 75 Hz
  mode, and xwayland-satellite gives it X11 apps. wlsunset takes over the night light from
  hyprsunset, which only works on Hyprland. Hyprland's tree controls, resize submap,
  monocle toggle, and Obsidian/Todoist workspace rules have no Niri counterpart here.
- **home/noghartt/herdr**: Herdr 0.9.3 -> 0.9.5: `herdr plugin update`, agent sessions survive a
  Mac restart, the server outlives the shell that started it, Ctrl shortcuts on non-Latin
  layouts, lower CPU on big sessions; 0.9.5 fixes prefix keys sent as text (input methods,
  Ghostty `text:` binds) and stops installing Codex turn hooks.
- **overlays**: Ghostty 1.3.1 -> 1.4.0 on the Macs. `overlays/ghostty.nix` pins the release `.dmg`
  until the locked `nixpkgs-darwin` reaches 1.4.0, then steps aside. Mellon stays on nixos-unstable's
  1.3.1 until that channel ships 1.4.0.
- **home/noghartt/pi**: destructive-guard no longer asks Jev to clear gray-zone actions. What
  its deterministic checks (self-harm blocks, temp-dir and session-owned files and processes,
  worker worktrees) cannot clear now always asks you, or is refused without a UI or during an
  `/unsupervised` run. Applies to Pi and OmO alike; Jev still drives the orchestrator and swarm.
  In its place the project is the boundary: `rm`, truncate, forced `cp`/`mv`, recursive
  `chmod`/`chown`, and overwriting writes pass when every target is inside the session's git
  repository (or worktree), while its root, `.git`, `.env`/credential files, destructive Git
  commands, and anything outside it still ask.
- **home/noghartt/cli**: interactive zsh starts in ~0.2s again instead of ~5s. The
  1Password secrets resolved into the shell env (`opnix env`, ~4s per call) are cached for 4h
  in a private per-user runtime dir and refreshed in the background once stale; only the
  first shell after login, or after the env var list changes, waits for 1Password.
- **home/noghartt/pi**: orchestrator workers default to Sonnet 5.5; Jev moves a node to Opus 5.5,
  now at `medium` instead of `high`, only when it confidently rates the work complex (an unsure
  pick stays on Sonnet instead of taking the higher tier). Fable 5.1 and GPT-6 Astra are no
  longer Jev picks or escalation steps: the leader assigns them to specific nodes through
  `orch_spawn`'s new `model` field. The leader stays on Opus 5.5 at `xhigh` and plain OmO
  sessions on Opus 5.5 at `high`.
- **home/noghartt/omo**: OmO 5.1.33 -> 5.1.60, on the host and in swarm pods.
- **home/noghartt/cli**: Claude Code 2.1.295 -> 2.1.318.
- **overlays**: Codex 0.162.0 -> 0.166.0. `overlays/pi.nix` no longer overrides Pi, which now
  follows nixpkgs (1.5.0 on the Macs, 1.4.0 on Mellon); it only builds `pi-durable`, kept at
  1.0.1, the last release with its CLI entry point.
- **home/noghartt/omo**: OmO 5.1.28 -> 5.1.33, on the host and in swarm pods. 5.1.28 refused
  every MCP call in a running session after any config reload (a Home Manager switch or another
  non-routine `settings.json` write) with "MCP session or server configuration was replaced",
  until the session restarted; 5.1.33 no longer ties a session's MCP tools to the config
  object that was current when they were registered. The builtin `unspecified-low` chain now
  leads with `gpt-6.1-sol` on the ChatGPT lane, which is not in the picker catalog; this file
  does not override that category, and `session-model` pins it on the Claude subscription.
- **home/noghartt/omo**: Claude limit savings, to test. Routine category subagents (quick,
  writing, deep-low, unspecified-low/high, visual-engineering) run on Sonnet 5.5 while the session
  is on the Claude subscription; Opus 5.5 and Sonnet 5.5 sessions compact at ~250k instead of
  ~984k; the `omo` launcher defaults `CLAUDE_CODE_PROMPT_CACHE_TTL=5m`, since 1h cache writes
  cost 2x but monobloco logs showed them missing after ~5 idle minutes anyway.

- **docs**: Mellon's Herdr is reached from the Mac as a saved Herdr machine
  (`herdr machine add mellon`) instead of an SSH login running Herdr, whose keys the Mac's
  Herdr caught first. What runs there lives in Mellon's Herdr server, so an orchestrator
  leader and its workers survive the Mac sleeping; a plain `ssh mellon` stays a shell.

- **mellon/sandboxes**: `agentbox` reaches `agentbox-root` through a socket-activated root
  daemon (`agentbox-rootd`) that authorizes callers by the `agentbox` group database, so
  processes started before the user joined the group just work; the sudo rule and the
  `sg agentbox` fallback are gone. Interactive `exec`/`shell` get a real pty with job control and
  live window size. Sandboxes resolve through a host-side sandbox resolver instead of 1.1.1.1 and
  9.9.9.9, `recreate` keeps the network profile and size, and sandbox networking moved to
  `network.nix`.

- **home/noghartt/pi**: the orchestrator's index.ts is split into `limits.ts`, `placement.ts`,
  `priors.ts`, `outcomes.ts`, `consult.ts`, and `publish.ts`, with bun unit tests the package
  leaves out. A worker's `OMO_CLOUD_ENV` is now the per-node env choice, not the leader's list.

- **home/noghartt/swarm**: `config.json` follows the orchestrator: the leader is the first
  Opus 5.5 with credentials at `xhigh`, and the member pool is `sonnet`/`opus`/`fable`/`gpt-astra`
  with preference-ordered fallback chains (GPT-5.6 Terra, GPT-6 Sol); members run the first
  model they have credentials for, and default member thinking is `medium`. Claude Haiku,
  GPT-5.6 Sol and Luna, and the `optIn` mechanism are gone. The sbx kit, with its arm64 OmO
  download, is built on Darwin only.

- **home/noghartt/omo**: cloud-mode's `publish` also takes a delivered subagent branch
  (`sandbox/<box>/<branch>`) and pushes it under `<branch>` by default; subagents cannot publish.

- **home/noghartt/pi**: the orchestrator's worker pool is three tiers: Sonnet 5.5 for easier
  work (GPT-5.6 Terra as fallback), Opus 5.5 at high thinking for complex work (GPT-6 Sol as
  fallback), and Fable 5.1 or GPT-6 Astra for orchestration-level and the hardest work. A pick
  moves to the other provider's model once its own provider's plan limits reach 85% (read
  from the statusline's shared cache). Claude models use the authenticated
  `anthropic-subscription` provider, with Pi's `anthropic` as fallback.

- **mellon/sandboxes**: each sandbox sees an 8-core CPU window, so test runners inside start
  8 workers instead of one per host core (a 12-lane run had vitest workers OOM-killed in one
  16G sandbox). All sandboxes together get half the default CPU weight and are throttled
  from 36G, before the 40G cap.

- **home/noghartt/omo**: the interactive model picker and native task chains use
  Opus 5.5, Sonnet 5.5, Fable 5.1, GPT-6 Astra, and GPT-6 Sol. Delegated
  `deep-low` work starts on GPT-6 Sol rather than GPT-6.1 Sol; the other chains
  no longer route to GPT-5.6 Sol or GPT-6 Luna. New sessions still start on
  Opus 5.5 at high thinking; the other models are available for manual picks
  and delegated work.

### Added

- **mithril**: personal M4 Pro MacBook Pro as a nix-darwin host with Palantir's full setup.
  Both Macs now share `hosts/common/optional/macbook.nix` (casks, language defaults) and
  `home/noghartt/features/darwin` (apps, agent stack, Ghostty launching Herdr); the swarm
  Pi package is pinned last with `mkAfter` so the shared import keeps its load order.

- **home/noghartt/leverage**: Leverage Computer CLI (`leverage` 0.2.108) on Palantir, pinned
  by hash in Nix instead of upstream's `~/.local/bin` installer, with its self-updater off.

- **home/noghartt/omo**: `session-model` extension. Category subagents (`task` with
  `category`) now run on the parent session's current model and thinking level, following
  `/model` switches, instead of the category chain in `omo.jsonc`. Each category spawn is
  rewritten into a model-pinned spawn with a one-line lane note, so it gives up OmO's
  per-category prompt, per-category tools, and chain fallback; `subagent_type` spawns
  (explore, librarian, reviewers) keep their own chains.

- **mellon/sandboxes**: network profiles (`agentbox net`, `ensure --net`): `none`, `dev` (default
  for new sandboxes: only allowlisted domains, through the sandbox resolver and ipsets), and
  `open`, switched live. Sandboxes made before profiles count as `open`.

- **mellon/sandboxes**: size classes (`agentbox size`, `ensure --size`): small 4 cores/8G, medium
  8/16G (default), large 16/32G, applied live; `agentbox ls` shows net and size.

- **mellon/sandboxes**: a NixOS VM test of the sandbox stack, `checks.x86_64-linux.agentbox`
  (daemon authorization and TTY, exit codes, parallel execs, sizes, all three net profiles,
  recreate).

- **home/noghartt/pi**: orchestrator workers get one agentbox sandbox per node from a leader
  on the host (`workers.placement` auto/sandbox/worktree; auto picks sandboxes on Mellon), seeded
  from the host checkout and collected back into it, with no cloud mode needed. Jev picks each
  node's placement, network profile, size class, and env keys from a fixed menu, and
  deterministic guardrails override it.

- **home/noghartt/pi**: `orch_consult` gets a second opinion from Fable 5.1, or GPT-6 Astra when
  Claude's limits run hot; the same consultant audits plans of 4 or more nodes before they start,
  and every result that needs the leader. The leader stays on Opus 5.5 at `xhigh`.

- **home/noghartt/pi**: `orch_publish` pushes an accepted node's branch over SSH (never forced,
  never the default branch), optionally with a draft PR.

- **home/noghartt/pi**: the orchestrator logs every settled node attempt to
  `agent-evals/outcomes.jsonl`, and feeds `agent-evals/priors.json` into Jev's model pick.

- **home/noghartt/omo**: cloud-mode subagents that can write get their own sandbox,
  `<parent>-<short>`, cloned from the parent's sandbox at its HEAD on branch
  `task/<parent>/<short>`, and deliver it back into the parent's clone as
  `sandbox/<box>/task/...` after each turn and on exit. Read-only types (explore, librarian,
  reviewers) keep sharing the parent's sandbox. `--net` and `--size` choose the sandbox's
  network profile and size class and carry over to children.

- **mellon**: the agent forum (`agent-forum.service`, port 7410 on loopback and the tailnet
  only): threads with kinds, statuses, tags, replies, votes, claims, subscriptions, a
  cursor-based long-poll wait, a read-only HTML view, per-author rate limits, and 60-day pruning
  of resolved threads; Bun and SQLite under a hardened DynamicUser unit, with tests in the
  package build and a NixOS VM test. Pi and OmO get `forum_post`, `forum_reply`, `forum_read`,
  `forum_search`, `forum_wait`, `forum_claim`, and `forum_resolve`.

- **home/noghartt/swarm**: an `agentbox` member backend on Mellon. Each member gets its own
  nspawn sandbox while its OmO stays on the host as a Herdr tab aimed at it; branches return
  with `agentbox collect`, evolve children seed from their parent's sandbox, and `swarm rm`
  removes the sandboxes. `--backend auto` (the new default) picks it where `agentbox` exists,
  and the swarm feature is now imported on Mellon.

- **home/noghartt/agent-evals**: `aeval`, a local eval pipeline over agent transcripts (OmO,
  Pi, Claude Code, Codex) and the orchestrator's outcome log: incremental ingest with secret
  redaction and derived signals, a keyboard labelling TUI, heuristic and LLM task
  classification, reports per model, pool key, and task class, `priors.json` for the
  orchestrator's model choice, OpenAI and Anthropic SFT and preference exports from labelled
  data, and replays of recorded tasks on candidate models. Ingest runs hourly on both hosts.

- **mellon/sandboxes**: `agentbox recreate NAME` moves a sandbox onto the current image and
  restores its repos, uncommitted work, env opt-ins, keep, and address. Archives (expiry and
  recreate) now also keep uncommitted work as `refs/agentbox/wip`, plus a manifest and the
  agent's git identity.

- **home/noghartt/pi**: orchestrator nodes take `repo`, another repository to work on. In
  cloud mode its sandbox is seeded from that repository and its branch is collected back into
  it, so working on a second repo no longer means smuggling its history into the leader's.

- **home/noghartt/cli**: btop on every host, as a modern htop replacement.

- **mellon/sandboxes**: `TYPESAFE_API_KEY` joins the sandbox env catalog, so a sandbox can
  opt in (`agentbox env NAME ... TYPESAFE_API_KEY`) for Jev-gated orchestrator or swarm runs
  inside it.

- **home/noghartt/omo**: `omo --cloud local --sandbox` runs the session's tools in this
  machine's own agentbox sandboxes without SSH, and an orchestrator leader started that way
  provisions, inspects, and collects its workers' sandboxes the same way. OmO on Mellon (in
  Herdr, reached over SSH) can now run sandboxed agents and orchestrator runs overnight with
  the Mac closed; SSHing into itself would have waited on the 1Password agent's approval.

- **mellon**: unattended git pushes to GitHub. A dedicated GitHub SSH key, kept as the
  `Nix/mellon-github` 1Password item and written to `~/.ssh/github_mellon` by opnix, serves
  `github.com` only, and GitHub's host key is pinned; the desktop 1Password agent, which needs
  an on-screen approval and locks when idle, still signs for every other host.

- **repo**: `.envrc` loads the flake's dev shell through direnv (`.direnv/` is ignored).

- **mellon**: isolated agent sandboxes. Each is a systemd-nspawn container booted from a btrfs
  snapshot of a Nix-built base image under `/agent`, with a private user namespace, its own
  veth limited to public IPv4 (no host, LAN, tailnet, or other sandboxes), its own Nix store,
  no host mounts, and per-sandbox cgroup limits. The `agentbox` CLI creates, seeds (git bundle
  of a host repo), enters, collects branches from, and removes them through one sudo-allowed
  root helper. Sandboxes sit on fixed subnets in `10.231.0.0/16`, advertised to the tailnet, and
  resolve as `<name>.sandbox.internal` through a tailnet-only dnsmasq, so their servers are
  reachable from other devices by name; the isolation rules moved to the mangle table so
  tailscaled's and Docker's forwarding rules cannot bypass them.

- **mellon**: agent sandboxes expire from disuse. An hourly reaper stops a sandbox after 12h
  idle and removes it after 7 days, first archiving every repo's committed branches as git
  bundles under `/agent/archive/<name>/` (kept 30 days), which reclaims its btrfs subvolume.
  Open shells and cloud-mode sessions count as use; `agentbox keep NAME 30d|forever|off`
  exempts one, and `agentbox ls` shows idle time and expiry. Cloud mode warns when it
  recreates an expired sandbox and points the session at the archive.

- **home/noghartt/omo**: `/unsupervised <task>` prompt template (adapted from fersilva16's
  config): ultrawork, no questions, tested end to end, left uncommitted for review (committed
  on a branch inside a sandbox). During such a run destructive-guard refuses what Jev does not
  clear instead of opening a dialog, and orchestrator workers it spawns inherit the mode.

- **home/noghartt/pi**: orchestrator workers run in agentbox sandboxes when the leader is in
  OmO cloud mode. Each isolated node gets its own sandbox on the leader's host, seeded from the
  leader's checkout (or the leader's own sandbox) and branched from its last commit; the worker
  stays a visible local OmO pane whose tools run in the sandbox unattended, Jev reads its
  evidence over SSH, and its branches are collected into the leader's repo as
  `sandbox/<box>/*` when it finishes. `agentbox ensure --from` and `agentbox collect --into`
  seed from and deliver to another sandbox.

- **mellon**: sandbox environment variables. `sandboxes/env-catalog.nix` declares what may be
  given (1Password references resolved at boot by opnix's NixOS module, or non-secret
  literals); each sandbox opts in with `agentbox env NAME KEY...`, and `agentbox exec` exports
  them inside without putting values on a command line. The catalog starts with a read-only
  `GH_TOKEN` for the image's `gh` (API reads; Git itself stays on SSH).

- **home/noghartt/omo**: cloud mode's `--env KEY,KEY` opts a sandbox into catalog variables
  (orchestrator workers inherit the list), and a `publish` tool pushes a branch from the remote
  host or sandbox through the local clone over SSH (HTTPS GitHub origins rewritten to SSH), never forced and never to
  the default branch, optionally opening a draft PR.

- **home/noghartt/omo**: `cloud-mode` `--sandbox[=name]` (and `/cloud <host> --sandbox`) runs
  the session's tools inside an `agentbox` sandbox on the target host, created from the host
  directory's repo on first use and reattached on resume and by subagents.

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

- **home/noghartt**: Mellon's Ghostty launches Herdr directly, like Palantir's; tmux, Pi's
  tmux helpers, and rofi are no longer imported there, and `Super+D` opens Noctalia's launcher.
  Hyprland gains i3-style tree control: `Super+E` toggles the split, `Super+H`/`Super+V`
  preselect, `Super+W` toggles a tab group (`Super+Tab` cycles it, `Super+Alt+<dir>` merges
  into a neighbour, `Super+Shift+W` leaves it), and `Super+M` toggles monocle; the resize mode
  moves to `Super+Shift+R`. A declared Adwaita cursor covers Hyprland, XWayland, and GTK, and
  wl-clipboard (Herdr's copy actions) and pavucontrol join Mellon's packages.

- **mellon**: `hardware-configuration.nix` is the real `nixos-generate-config` output (initrd
  and kernel modules, AMD microcode) instead of the placeholder; filesystems stay with disko.

- **home/noghartt/pi**: destructive-guard no longer checks bash, write, or edit in an agentbox
  sandbox session, so sandboxed agents run any command there unattended; destructive-named
  tools that act outside the sandbox are still checked.

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

- **mellon/sandboxes**: a killed `agentbox exec` client no longer leaves its command running in
  the sandbox.

- **home/noghartt/omo**: parallel cloud-mode `task` subagents no longer share one sandbox; on
  2026-10-12, 11 lanes in one 16G sandbox OOM-killed each other's vitest workers and overwrote
  each other's files.

- **mellon/sandboxes**: `agentbox` works from processes started before the user joined the
  `agentbox` group (a long-lived Herdr server), through `sg`, instead of failing with
  `sudo: a password is required`. Sandbox boots no longer log failed `specialfs` remounts,
  shutdowns no longer fail to unmount `/tmp`, and `agentbox-root` calls no longer journal a
  PAM session each.

- **home/noghartt/pi**: orchestrator workers in Herdr open their tab in the leader's workspace
  rather than whichever one is focused, Herdr's own error text reaches the leader, and a failed
  pane rename no longer fails the worker (it failed a whole 12-node wave).

- **home/noghartt/omo**: Opus 5.5 now uses the authenticated `anthropic-subscription`
  provider in the startup reset, picker, task chains, and image overrides.
  The unauthenticated `anthropic` ID was ignored at session creation, leaving
  new chats on GPT-6 Sol despite the saved Opus default.

- **mellon**: commands run through `agentbox exec` keep their `${...}` expressions for the
  sandbox's shell. systemd-run expanded them first, against its own environment, so cloud mode
  could not read `AGENTBOX_HOST` and `${#VAR}` or `${VAR-default}` broke.

- **mellon**: a Secret Service keyring now exists (gnome-keyring, unlocked at greetd login,
  Seahorse to inspect it), so 1Password and other libsecret apps can persist secrets instead
  of failing with "name is not activatable". gcr's SSH agent stays off; 1Password remains the
  SSH agent.

- **mellon**: `tailscale login`/`up`/`set` no longer need sudo; the desktop user is declared
  as tailscaled's operator (`services.tailscale.extraSetFlags`).

- **mellon**: us-intl dead keys work in Ghostty: GTK uses its simple input method
  (`GTK_IM_MODULE=simple`) instead of Hyprland's text-input-v3, which swallowed them with no
  input method running. greetd starts the session through Hyprland's `start-hyprland`.

- **home/noghartt/omo**: OmO's JavaScript eval kernel starts outside a direnv dev shell. Its
  process-isolated kernel spawns `bun` from PATH, which only the dev shell provided; the `omo`
  launcher now puts nixpkgs' `bun` first on PATH (and the dev shell keeps one too).

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

- **home/noghartt**: Jev (TypeSafe) gating, strategy, placement, and model picks; the swarm
  feature (`swarm` CLI/daemon, `/leader`, `/swarms`, sbx kit, `SWARM.md`); `aeval priors` and the
  orchestrator's priors input; the plan/needs_leader consultant audits.
- **mellon**: hibernation (resume device, the pending `resume_offset` step) and NVIDIA
  suspend VRAM preservation; system sleep is now refused so Mellon runs 24/7.
- **home/noghartt/herdr**: drop the reviewr plugin in favor of the lazygit popup on
  `Alt+R`; activation unlinks its stale registration.
- **home/noghartt/pi**: drop the `pi-claude-bridge` package and its config; Pi's
  Claude models now use the native `anthropic` provider (`/login anthropic`). Under
  OmO the bridge's Claude Code query is aborted at every tool call, so sessions that
  inherited it failed with "Model returned an empty response twice".
- **home/noghartt**: Leverage Computer CLI is no longer installed on Mithril; it stays on
  Palantir.

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

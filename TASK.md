# TASK.md

Working checklist for the nixcfg rebuild. Keep this file updated as items land.

## Foundation

- [x] Fix flake.nix (`outputs`, `nixosConfigurations`, `follows`)
- [x] lib helpers: `mapDir` (directory-driven hosts) + `mkNixOSConfig`
- [x] Foundry layout: `hosts/{common,<host>}` + `home/<user>/{user.nix,home.nix,features,<host>.nix}` with portable/platform HM composition
- [x] Host specs: `mkNixOSConfig` maps host fields (`users`, `imports`) into modules; overridable user factories (call / `overrideAttrs`)
- [x] Custom option-only modules (`device.type`) auto-imported into NixOS + HM
- [x] home-manager as NixOS module; per-host HM entrypoint keyed by `networking.hostName`
- [x] devShell (nixd, nixfmt, statix, deadnix) + formatter output (manual formatting remains `nixfmt <file>`)

## mellon — NixOS desktop

- [x] NVIDIA Blackwell module (`nixos-hardware` architecture baseline + host-pinned driver and desktop policy)
- [x] disko: shares the NVMe with Windows; formats only the labelled Linux partitions (2G ESP + LUKS -> LVM: root 500G, agents 300G at /agent, home remainder), btrfs subvolumes @ @nix @var_log @snapshots + @agent + @home; zram swap
- [x] Hardware stack: independently locked Linux 7.1.4 + firmware/microcode 20260622; NVIDIA 595.84 pinned in `nvidia.nix`
- [x] Boot: Lanzaboote Secure Boot + systemd initrd + encrypted LVM
- [x] Desktop: Niri (Wayland) + greetd + pipewire + bluetooth (replaced Hyprland)
- [x] `time.timeZone` (America/Sao_Paulo)
- [ ] Install day: follow `INSTALL.md` exactly (Windows prep, Linux partitions beside Windows, Disko format, temporary LUKS secret, hardware config, Lanzaboote keys, login password)
- [ ] Install day: after passphrase and Secure Boot validation, enroll TPM2 LUKS unlock with a PIN and test passphrase fallback
- [ ] Pre-install decision: keep a persistent root or add Foundry-style impermanence (requires a Disko persistence subvolume and explicit state inventory)
- [x] docker + compose (daemon on the host, `docker` group via user factory `overrideAttrs`, NVIDIA container toolkit)
- [x] Reliability: SMART monitoring + desktop notifications, weekly fstrim, power-profiles-daemon, bounded journal/Docker growth, root Snapper timeline
- [x] Networking: NetworkManager + RTL8922AE desktop tuning, Brazilian regulatory domain, systemd-resolved, native firewall, Tailscale, Cloudflare WARP, Wireshark capture
- [x] Always-on: system sleep refused, hibernation and NVIDIA suspend VRAM preservation dropped
- [x] Remote access: hardened key-only sshd on the tailnet only, authorized keys kept by hand (unmanaged), forwarded-agent `~/.ssh/rc`
- [x] Nix `min-free`/`max-free` guards, CUDA binary cache, Docker published ports on loopback by default
- [x] Gaming: Proton-GE; RTL8922AE power saving off at the driver
- [x] OmO on Mellon: x86_64 release binary through nix-ld, per-session systemd memory scope, linger
- [ ] Verify OmO on Mellon after install (binary starts under nix-ld, scope limits apply, eval kernels run)
- [x] OmO `cloud-mode`: `--cloud`/`/cloud` runs read/write/edit/grep/bash on an SSH host (verified against an OrbStack Ubuntu machine: tools, eval `tool.*`, background server + `kill_bash`, fail-closed, resume)
- [ ] First `omo --cloud mellon` run from Palantir once Mellon is installed; measure per-call latency over Tailscale
- [x] Orchestrator: three-tier pool with limit-based spill, per-node `repo`, Herdr tab in the leader's workspace, non-fatal pane rename
- [x] Swarm config aligned with the orchestrator tiers (no Haiku, no GPT-5.6 Sol/Luna, `anthropic-subscription` first)
- [x] Orchestrator: host-side leader with a worktree per node, `orch_consult` + plan/needs_leader audits (Fable 5.1 / GPT-6 Astra), `orch_publish`, outcome log and priors
- [x] Agent forum: Mellon service (`hosts/mellon/agent-forum`) + Pi/OmO client tools (`forum_*`)
- [x] agent-evals: `aeval` ingest/label/classify/report/priors/export/replay (`features/agent-evals`)
- [ ] Verify after rebuild: `orch_consult` answers from Fable (Astra when Claude limits are at 85%+), and `orch_publish` pushes a worktree node's branch under a new name with a draft PR and refuses the default branch
- [ ] Verify after rebuild: `~/.local/state/agent-evals/outcomes.jsonl` gains one line per settled attempt (directory 0700, file 0600), then `aeval ingest` counts them
- [ ] Follow-up: tag `workpool`/`workflow`/`team_*` spawns like `task` in cloud-mode; typecheck the TypeScript extensions (no tsc in the dev shell)
- [ ] Verify the forum after rebuild: `systemctl status agent-forum`, the journal lists 127.0.0.1:7410 plus the tailnet addresses, `ss -ltnp | grep 7410` shows no 0.0.0.0 or LAN address, `curl http://mellon:7410/api/health` from Palantir, and an OmO session loads `forum_*` through tool_search (Pi: active at start) for a post/wait/claim/resolve round trip across two machines
- [ ] Verify aeval after rebuild: the hourly timer (Mellon) / launchd agent (Palantir) runs clean, `aeval classify --llm --limit 5` works through `omo -p`, `aeval replay` on a real session, and Codex/Pi parsing on first real files
- [ ] Start labelling sessions in `aeval label` so reports and exports have data
- [x] `/unsupervised <task>` OmO template, inherited by orchestrator workers
- [ ] Try `/unsupervised` once after activation: template listed, ultrawork loads, a guarded command is refused without a dialog
- [x] Mellon GitHub key: create the `Nix/mellon-github` SSH Key item (ed25519) and add its public key to GitHub before rebuilding; then `ssh -T git@github.com` on Mellon answers without a 1Password prompt
- [x] Gaming: Steam + GameMode (32-bit graphics already enabled by the NVIDIA module)
- [ ] Verify the work WARP profile uses traffic-only mode and excludes Tailscale IPv4/IPv6 ranges

## Home Manager

- [x] Terminal: Ghostty launches Herdr on Palantir and Mellon, with zsh (autosuggestion, syntax-highlighting)
- [x] tmux cross-session/window scrollback search with an fzf popup and copy-mode jump
- [x] cli tooling: eza, bat, fd, fff, fzf, lazygit, ngrok + browsers (firefox, chrome)
- [x] Herdr through its native Home Manager module, with release-pinned packaging, settings, and the Nix-managed lazygit popup plugin (`Alt+R`)
- [x] Herdr `Alt+A` agent tree popup: workspace/worktree groups, search, live status, and focus by pane ID
- [x] Herdr `Alt+P` PR tree plugin: all authored open PRs via `gh`, repository groups, search, browser opening, and URL copying
- [x] PR tree status badges: independent review/CI colors, draft/null/unknown states, status search, and narrow/monochrome rendering
- [x] Retain the PR tree bundle through its activation reference to avoid profile manifest collisions
- [x] AI coding agents: Claude Code, release-pinned Codex, OpenCode, Pi
- [x] Pi 1.0.1 overlay ahead of nixpkgs, plus the experimental `pi-durable` agent
- [x] Pi/tmux integration: CSI-u modified keys, checkout-rooted launcher, and cross-project transcript search popup
- [x] Pi destructive-action guard with fail-closed confirmation for dangerous commands and out-of-project or sensitive writes
- [x] Context-aware destructive guard: self-harm hard blocks, deterministic temp-file and session-process approvals, gray zone asks the user (Jev judge removed 2026-10-24), worker dialogs relayed to the orchestrator leader
- [x] Pi worktree agents for isolated parallel delegation, with an explicit current-checkout opt-out
- [x] Pi Workflows extension with its bundled workflow-authoring and automation skills
- [x] Pi/OmO orchestrator: Opus 5.5 (xhigh) leader + worker mesh, Jev-decided strategy, worker models, and result gating (`orch`)
- [x] Orchestrator dependency graphs: `after`/`workdir` nodes and review nodes with bounded fix loops
- [x] OmO simplification (2026-11-05): Jev, TypeSafe, swarm, and `aeval priors` removed; the leader judges settled workers itself; `session-model` replaced by category routing in `omo.jsonc`; AGENTS.md split into `docs/`; OmO version guard on ui-chrome/ui-prompt
- [ ] Apply the "implement directly by default" opening to `~/.claude/CLAUDE.md` by hand (the agent guard blocks edits to it)
- [ ] After the simplification rebuild: a plain OmO `task` category spawn lands on its `omo.jsonc` model, an `orch` run settles nodes as `done_ungated` with evidence attached, and no evaluation warning about `omoVerified` appears
- [x] Swarm mode design and decisions recorded in `SWARM.md`; `sbx` installed on Palantir
- [x] Swarm: daemon + board, member/leader extension (`/leader`), parallel and evolve patterns, Jev model pick and gating, skills, approvals, `/swarms` panel, `swarm` CLI, sbx kit
- [x] Swarm: local-backend end-to-end run (board negotiation, gating, generation 2 from a survivor, held permission, skill publish)
- [x] Pi `Cmd+P` command palette with Ghostty/tmux forwarding, grouped search, and extension commands hidden from slash autocomplete
- [x] Pi command-palette tree view with a centered ASCII undo tree and responsive node preview pane
- [x] `Ctrl+P` command palette listing built-in commands too, and `Alt+T` for the session tree view
- [x] `Ctrl+?` keybindings modal; skills left out of the command palette
- [x] OmO settings follow Pi's extensions, skills, and keybindings instead of a frozen adopted copy
- [x] OmO picker and task chains use Opus 5.5, Sonnet 5.5, Fable 5.1, GPT-6 Astra, and GPT-6 Sol, with authenticated subscription provider IDs and cross-provider fallbacks
- [x] OmO 5.1.28 with chains re-derived from its builtin `omo-task.js` (its new Haiku 5.5 rungs only reach explore/librarian/quick, which stay overridden)
- [x] OmO 5.1.33: MCP tools keep working in running sessions after a config reload
- [ ] Verify after rebuild: in a new `omo` session a telepatia MCP tool still answers after a non-routine `settings.json` change reloads the session
- [x] OmO memory guards: 1568px image cap (`models.json`), process-isolated JS eval kernels with idle parking (`codemode.json`), `omo-memwatch` launchd snapshot/notify/stop agent
- [ ] Tune `omo-memwatch` limits (4 GB warn / 12 GB stop) from its first real snapshots
- [x] Pi/OmO statusline: badge-free footer and fixed right sidebar column (fullscreen TUI) with title, context, subagents, orchestrator workers, a tokens-per-turn sparkline, Claude plan limit meters with pace words and run-out time, and a Todo section mirroring OmO's todo list
- [x] Cua Driver 0.33.1 on Palantir: pinned app + launchd daemon, skill for Pi/Claude/Codex (not OmO), Cua docs MCP
- [x] Agent PATH `gh` shim refusing GitHub comments/reviews for every harness (Pi, OmO, Claude Code, Codex)
- [x] Global `.omo/` git ignore; quiet Pi/OmO startup, condensed changelog, resume-hint exit, OmO tips off
- [x] OmO-only extension packages auto-discovered from `features/omo/extensions/`
- [x] Orchestrator: consistent `[orchestrator]` relay prefix + system-prompt note; `/agent` switch between omo and leader mode
- [x] OmO `ui-prompt`: prompt card + info line, in-prompt questions, `Ctrl+X` chords, `Tab` agent cycle, title with busy dot, turn footer, bar cursor
- [x] OmO `ui-chrome`: modal dialogs/pickers/panels over a faded backdrop, compact tool rows, transcript/code/notice/widget cards
- [ ] Recheck `ui-prompt`/`ui-chrome` internal hooks (their `host.ts` headers) on every OmO version bump
- [x] Bare `pi` on its own agent dir (`features/pi-next`), in parallel with OmO
- [x] `antigravity` tool in bare `pi`: `agy` as a sub-agent (Nix-tracked `pi-next/extensions/`)
- [ ] Try `agy acp` instead of `-p` if multi-turn or permission prompts through Pi are needed
- [x] `pi-durable` as a standalone feature (`features/pi-durable/`) on Pi's resource loader and TUI components
- [x] `pi-durable` parity: `/skill:*` and prompt templates, `@` paths, `/tree` + `/fork` + `/clone` on Durable forks, `/new` + `/resume` + `/name`, `/trust`, `/reload`
- [x] `pi-durable` agents: profiles (`agents/*.md`), `subagent` (parked or background), `parallel` fan-out with a cap, worktree isolation, `watch` (command/file/timer), `agents` + `sessions` messaging with an inbox, labels in `/tree`, `@session:`/`@agent:`/`@label:` references, agents panel + `/stop`, `/dashboard` + `pi-durable agents`
- [ ] Verify `pi-durable` agents with real models after the next switch: a profile with its own model, a `parallel` of `worker`s merging cleanly, a background subagent's report, a `watch` on a real test run, a message between two open sessions
- [x] `pi-durable` `/btw` (tool-less side question, not kept) and `/status` (subscription limits, today's usage across sessions, session counts)
- [x] `pi-durable` Claude multi-account fallback: `pi-durable accounts login/list/remove`, an `AccountPool` that moves a request limited before content to the next account, shared blocks in `accounts/state.json`
- [ ] Sign a second Claude account in with `pi-durable accounts login` (browser) and watch a real usage-limit switch and the return to `main`
- [x] `/accounts` in the TUI: list logins by provider (emails, blocks, active), `add <name>`, `login <provider>` (OAuth), `remove <name>`; the pool reloads in the open session
- [ ] Finish a real `/accounts add` and `/accounts login openai-codex` sign-in in the TUI (checked only up to the code prompt)
- [ ] Try `/btw` mid-run in the TUI (panel over a running bash, Esc aborting) and `/status` with a Claude login after the next switch
- [ ] Try `git twig` worktrees: a `worker` subagent in a large repo (TWIG_TRACE=1 shows CoW), and `git twig adopt --dry-run` on existing worktrees; build git-twig on Mellon (Linux reflink path untested); `claude --worktree` and a Claude subagent with `isolation: worktree` (hooks), `herdr worktree create` (patch)
- [x] Rex integration for `pi` and pi-durable: program status (OSC 7501) and session-start context (`docs/rex.md`)
- [ ] Herdr is no longer used (Rex replaced it): decide whether to drop `features/herdr`, its twig patch, the herdr-state/herdr-fork Pi extensions and the orchestrator's Herdr placement, or keep them for Mellon
- [ ] Rex: open a pi-durable subagent or the orchestrator's workers in Rex panes (`rex split`), as Herdr placement did
- [x] `pi-durable` `/swarm` (agy-style coordinator, workers, mention-woken board, stall monitor, `/swarm board`)
- [ ] Verify `/swarm` with real models after the next switch: a worktree author plus a verifier, merged by the coordinator
- [x] `/swarm` members on other models than the coordinator (required profile, model-picking guide) and Antigravity members (agy runs per mention)
- [ ] Verify a mixed `/swarm` for real: Fable coordinator, Sonnet/Codex authors, a Codex or Opus verifier, a Gemini member through agy
- [ ] `/swarm` follow-ups: board channels, forked workers, uncommitted changes in worktrees, workers adding helpers
- [ ] `pi-durable` headless mode (`run "<prompt>"`, resumable) for unattended jobs
- [ ] `pi-durable`: Durable hooks (tests after edits), durable approvals (signals for `beforeTool` gates)
- [ ] `pi-durable`: spend caps per subagent/fan-out (beyond `maxTurns`), and a global cap on concurrent subagents
- [x] Deep research (`docs/deep-research.md`): `/research` + `research` skill, `researcher` and `research-critic` profiles, `web_search` (Exa/Kagi), `web_fetch` ladder (Exa, fetch, headless Chrome, Wayback, Kagi summarizer; cached), `lookup` (Wikipedia, OpenAlex, arXiv, HN, `gh`), `research_note`, `research_verify`
- [x] Deep research: `EXA_API_KEY` item in the `Nix` vault, mapped in `secrets-env.nix`
- [ ] Deep research: create the `KAGI_API_KEY` item (notes field), THEN add its mapping back to `secrets-env.nix` (`opnix env` fails all-or-nothing); run a first `/research` end to end with real keys (Exa highlights and Kagi request shapes are untested)
- [ ] Deep research: after the switch, check `web_fetch` reaches the `headless chrome` step through `PI_DURABLE_CHROME` (Macs and Mellon); restart the general `cua-driver` agent, which answered every call with `permissions_pending` (exit 75) during testing
- [ ] Deep research: opt-in logged-in route (`/research --logged-in`, a Cua Driver runtime with `--grant existing-profile` for that run only; Cua notes in the doc), hard spend caps per run
- [ ] Re-port `pi-durable` whenever nixpkgs moves Pi past `verifiedPiVersion` (evaluation warns)
- [x] Herdr `/fork` into a new pane (Pi + OmO) and OmO findings cache shared across worktrees
- [x] Statusline limits: shared cross-process cache + lock, ChatGPT group, pooled Claude accounts, pace ticks, todos-stalled marker
- [ ] Cua Driver first run: grant Accessibility and Screen Recording (`cua-driver permissions grant`), then check `cua-driver doctor`
- [x] Disable Claude's Bash/subagent sandbox after it proved unreliable with automatic permission mode
- [x] Writable Claude runtime settings with Nix-owned baseline keys and preserved injected hooks
- [x] Desktop shell: Noctalia (launcher, session, control center) + Polkit agent + lock/idle behavior + wlsunset night light
- [x] Migrate i3 workflow: workspaces, focus/move/resize, audio, launcher, session controls
- [x] Desktop apps: Todoist, Calibre, Zotero, Slack, Discord, Spotify
- [x] Jujutsu
- [x] git identity strategy (opnix-generated local include; bootstrap remains below)
- [x] Editor: shared Neovim Lua config and locked Lazy plugins on Mellon and Palantir
- [ ] prompt (starship?) + remaining shell tooling (zoxide)
- [ ] Declare a monitor option schema for connector, mode, scale, position, and workspace
- [ ] Add Mellon kanshi profiles after monitor connector names are known

## Sandboxes (sbx)

- [x] Retire agentbox (Mellon) and exebox (Macs); cloud-mode is plain SSH only, orchestrator uses worktrees
- [ ] Before rebuilding Mellon: clear the retired `10.231.0.0/16` route (`sudo tailscale set --advertise-routes=`) and delete the `sandbox.internal` split DNS entry in the Tailscale admin console
- [ ] Before rebuilding the Macs: collect any branches out of old exebox VMs and `ssh exe.dev rm` them (the exebox reaper goes away with the rebuild)
- [x] `sbx`: provider interface + contract tests, VM kinds (dev/agent/job), exe.dev provider on `@exedev/sdk`, git seed/pull via the GitHub integration, archive-then-reap (`features/sandbox`, `docs/sandbox.md`)
- [ ] exe.dev setup: `sbx auth setup` (tag-scoped token), link GitHub on the Integrations page, `sbx github add <owner/repo>` per repo, attach printed integrations by tag
- [ ] Live-verify `sbx` (`SBX_LIVE=1`): tag syntax and `tag --d`, `cp` of a paused template, tag-scoped token inheritance, `integrations attach` by tag, setup scripts with sudo, push through `github.int.exe.xyz`, remote kill on cancel; build `sbx` on Mellon (x86_64 tests not run yet)
- [x] pi-durable: sandbox `ExecutionEnv` (Durable's env conformance on the fake provider), `isolation: "sandbox[:<kind>]"` for subagent/parallel/profiles with pull-back as `sbx/<sandbox>/<branch>`, `--sandbox`/`/sandbox` sessions, `sandbox_run` and `sandbox_pull` tools (`docs/pi-durable.md` Sandboxes)
- [ ] Live-verify pi-durable sandboxes on exe.dev: a `sandbox:dev` subagent end to end (seed, bash/edit in the VM, commit, pull-back branch, removal), Esc during a long bash kills the remote group, a large `read` (snapshot chunks) and a spill file over the network, `--sandbox` then `--continue` reattaching, `/sandbox agent` (no internet; the prompt says so), the port URL in the prompt, `sandbox_run` artifacts, latency of the per-call round trips
- [ ] Measure exe.dev usage for a few weeks before deciding on standalone (metered) VMs
- [ ] Mellon provider: self-hosted runner implementing the `sbx` provider interface (passes `tests/contract.ts`)

## Tooling / CI

- [x] Allow direct-checkout work in this repository and ignore `.worktrees/`
- [x] Pin Codex 0.156.1 and Herdr 0.9.1 (2026-09-23)
- [x] Herdr 0.9.3, Codex 0.162.0, Claude Code 2.1.295 (2026-10-09)
- [x] Herdr 0.9.5; Codex from its complete release package for the app-server daemon (2026-10-26)
- [x] Retain Mellon's committed hardware pin while recording the userspace updates
- [x] Flake checks: nixfmt + statix + deadnix formatting check and builds for every discovered NixOS host
- [x] CI: run all flake checks on main/v2 pushes and pull requests
- [x] Generation revision/label + immutable `/etc/nixcfg` and `/etc/nixpkgs` breadcrumbs
- [x] Secrets: 1Password via opnix (HM user secrets; SSH keys via the 1Password agent)
- [x] Bootstrap: create a 1Password service account (Nix-vault scoped), then on the machine:
      `opnix token -path ~/.config/opnix/token set && chmod 600 ~/.config/opnix/token`
      (HM activation skips secret retrieval until this exists; git identity depends on it)
      — done on palantir; repeat the token step when bootstrapping mellon
- [x] Bootstrap: create the `git` item in the Nix vault with text fields `name` and `email`
      (an activation step composes them into the `~/.config/git/user` include)
- [x] Declare secrets as env vars in `home/noghartt/features/cli/secrets-env.nix`, starting with `TELEPATIA_LITELLM_API_KEY`

## palantir — work macbook

- [x] nix-darwin input + `mkDarwinConfig` helper
- [x] Second nixpkgs branch (`nixpkgs-unstable` for Darwin, keep `nixos-unstable` for NixOS)
- [x] Directory-discovered Darwin hosts + build checks
- [x] Cross-platform user factory with independent HM and nix-darwin state versions
- [x] Palantir host composition reusing Mellon's Chrome, Firefox, Ghostty, and Claude Code configuration
- [x] Install the Cloudflare Tunnel CLI (`cloudflared`) through Home Manager
- [x] Install Beancount and Fava through Home Manager
- [x] Install fswatch through Home Manager
- [x] Install Todoist through Homebrew (`todoist-app`)
- [x] Install Discord through Homebrew
- [x] Official Nix installer + first nix-darwin activation runbook (`DARWIN.md`)
- [x] First activation on the Mac and validate app copying, Spotlight discovery, and browser launch
- [x] Declarative Homebrew: nix-homebrew-managed installation + nix-darwin `homebrew` casks (1Password)
- [ ] Add macOS system defaults only after the managed-device policy is known
- [x] Make the custom Pi Claude bridge package build natively on Darwin before enabling it on Palantir
      (fixed upstream on the current `nixpkgs-darwin` pin; the Linux gate is removed)
- [ ] Decide whether arm64 macOS CI is worth the hosted-runner cost; until then validate on palantir

## mithril — personal macbook

- [x] Create the personal Darwin host using the shared palantir foundation
      (`hosts/common/optional/macbook.nix` + `home/noghartt/features/darwin`)
- [ ] Bootstrap on the M4 Pro (DARWIN.md): set the hostname, install Nix, opnix token, first `darwin-rebuild switch --flake .#mithril`
- [ ] Check `omo-memwatch` limits against this Mac's RAM (tuned for Palantir's 24 GB)
- [ ] homebrew module if an application is unavailable or unsuitable through nixpkgs
- [ ] Karabiner/Hammerspoon-style key remaps (ref: fersilva16 darwin modules)

## Someday / maybe

- [x] Snapper timeline on root `@` (separate mounts and home deliberately excluded)
- [ ] Off-machine backup destination and tested restore procedure for `/home`
- [ ] Theming namespace (colors/fonts shared across NixOS + HM)
- [ ] Per-host activation apps (`nix run '.#nixosActivations/mellon'`)

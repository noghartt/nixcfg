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
- [x] Desktop: Hyprland (Wayland) + greetd + pipewire + bluetooth
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
- [x] Agent sandboxes (systemd-nspawn): per-sandbox user namespace, cgroup limits, private network, btrfs subvolumes under /agent/sandboxes, `agentbox` CLI, `omo --cloud mellon --sandbox` from Palantir's OmO
- [x] Verify sandboxes after the next Mellon rebuild: base image lands, `agentbox ensure` boots and seeds, no host/LAN/tailnet reach, internet egress, uid mapping, slice limits, `kill_bash` stops sandbox processes
- [x] Sandbox tailnet access: approve the `10.231.0.0/16` route and add split DNS `sandbox.internal` -> Mellon's tailnet IP in the admin console, then verify `<name>.sandbox.internal:<port>` from Palantir
- [x] Sandbox idle expiry: `agentbox-reap.timer` stops after 12h idle, removes after 7d (branches archived to `/agent/archive` for 30d), `agentbox keep`, cloud-mode notice on recreation
- [ ] Verify sandbox expiry after the next Mellon rebuild: timer active, `agentbox ls` idle/expiry columns, `keep`, a forced reap (`touch -d '8 days ago' /agent/meta/<name>.used`) archives and removes, bundles fetchable by the user
- [ ] Swarm `nspawn` backend on agentbox sandboxes (replacing sbx on Mellon)
- [x] Orchestrator workers in agentbox sandboxes (`OMO_CLOUD` + `OMO_CLOUD_SANDBOX` per worker; evidence collection through `agentbox exec`)
- [x] Sandbox env catalog (opnix-resolved, opt-in per sandbox via `agentbox env` / `--env`), read-only `GH_TOKEN`, and cloud-mode `publish` (push over SSH + draft PR via the local gh)
- [ ] Before the next Mellon rebuild: create the 1Password item `Nix/AGENTBOX_GH_TOKEN` (fine-grained, read-only contents/metadata/issues/pull requests; token in notes) and run `sudo opnix token set` on Mellon; then check `opnix-secrets.service`, `agentbox env <box> GH_TOKEN`, `gh auth status` inside, and one `publish` with a draft PR
- [ ] Verify sandboxed orchestrator workers after the next rebuild: `omo --cloud mellon --sandbox`, `/agent orchestrator`, `/unsupervised <goal>`; workers get `o<run>-<node>` sandboxes and Herdr tabs, Jev gates them, branches land as `sandbox/<box>/*` in the leader's sandbox
- [x] Gaming: Steam + GameMode (32-bit graphics already enabled by the NVIDIA module)
- [ ] Verify the work WARP profile uses traffic-only mode and excludes Tailscale IPv4/IPv6 ranges

## Home Manager

- [x] Terminal: Ghostty launches Herdr on Palantir and persistent tmux on Mellon, with zsh (autosuggestion, syntax-highlighting)
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
- [x] Context-aware destructive guard: self-harm hard blocks, deterministic temp-file and session-process approvals, Jev-judged gray zone, worker dialogs relayed to the orchestrator leader
- [x] Pi worktree agents for isolated parallel delegation, with an explicit current-checkout opt-out
- [x] Pi Workflows extension with its bundled workflow-authoring and automation skills
- [x] Pi/OmO orchestrator: Opus 5.5 (xhigh) leader + worker mesh, Jev-decided strategy, worker models, and result gating (`orch`)
- [x] Orchestrator dependency graphs: `after`/`workdir` nodes and review nodes with bounded fix loops
- [ ] Store the TypeSafe key as `op://Nix/TYPESAFE_API_KEY/notesPlain` and run a first real-Jev orchestration
- [x] Swarm mode design and decisions recorded in `SWARM.md`; `sbx` installed on Palantir
- [x] Swarm: daemon + board, member/leader extension (`/leader`), parallel and evolve patterns, Jev model pick and gating, skills, approvals, `/swarms` panel, `swarm` CLI, sbx kit
- [x] Swarm: local-backend end-to-end run (board negotiation, gating, generation 2 from a survivor, held permission, skill publish)
- [ ] Swarm: `sbx login`, then first sbx run: kit build, pod auth copy, board reachability, tmux in detached pods (SWARM.md "Untested on sbx")
- [ ] Swarm: measure pod/member memory and tune `podSize`/`podMemory`; 20+ member scaling run
- [ ] Swarm: first `/leader` run in OmO (leader dialogs, panel attach in Herdr, credential refresh)
- [ ] Swarm on Mellon (sbx lacks NixOS support; revisit)
- [x] Pi `Cmd+P` command palette with Ghostty/tmux forwarding, grouped search, and extension commands hidden from slash autocomplete
- [x] Pi command-palette tree view with a centered ASCII undo tree and responsive node preview pane
- [x] `Ctrl+P` command palette listing built-in commands too, and `Alt+T` for the session tree view
- [x] `Ctrl+?` keybindings modal; skills left out of the command palette
- [x] OmO settings follow Pi's extensions, skills, and keybindings instead of a frozen adopted copy
- [x] OmO `omo.jsonc` model chains with same-tier cross-provider fallbacks
- [x] OmO 5.1.28 with chains re-derived from its builtin `omo-task.js` (its new Haiku 5.5 rungs only reach explore/librarian/quick, which stay overridden)
- [x] OmO memory guards: 1568px image cap (`models.json`), process-isolated JS eval kernels with idle parking (`codemode.json`), `omo-memwatch` launchd snapshot/notify/stop agent
- [ ] Tune `omo-memwatch` limits (4 GB warn / 12 GB stop) from its first real snapshots
- [x] Pi/OmO statusline: badge-free footer and fixed right sidebar column (fullscreen TUI) with title, context, subagents, orchestrator workers, a tokens-per-turn sparkline, Claude plan limit meters with pace words and run-out time, and a Todo section mirroring OmO's todo list
- [x] Cua Driver 0.33.1 on Palantir: pinned app + launchd daemon, skill for Pi/Claude/Codex (not OmO), Cua docs MCP
- [x] Agent PATH `gh` shim refusing GitHub comments/reviews for every harness (Pi, pi-durable, OmO, Claude Code, Codex)
- [x] Global `.omo/` git ignore; quiet Pi/OmO startup, condensed changelog, resume-hint exit, OmO tips off
- [x] OmO-only extension packages auto-discovered from `features/omo/extensions/`
- [x] Orchestrator: consistent `[orchestrator]` relay prefix + system-prompt note; `/agent` switch between omo and leader mode
- [x] OmO `ui-prompt`: prompt card + info line, in-prompt questions, `Ctrl+X` chords, `Tab` agent cycle, title with busy dot, turn footer, bar cursor
- [x] OmO `ui-chrome`: modal dialogs/pickers/panels over a faded backdrop, compact tool rows, transcript/code/notice/widget cards
- [ ] Recheck `ui-prompt`/`ui-chrome` internal hooks (their `host.ts` headers) on every OmO version bump
- [x] Herdr `/fork` into a new pane (Pi + OmO) and OmO findings cache shared across worktrees
- [x] Statusline limits: shared cross-process cache + lock, ChatGPT group, pooled Claude accounts, pace ticks, todos-stalled marker
- [ ] Cua Driver first run: grant Accessibility and Screen Recording (`cua-driver permissions grant`), then check `cua-driver doctor`
- [x] Disable Claude's Bash/subagent sandbox after it proved unreliable with automatic permission mode
- [x] Writable Claude runtime settings with Nix-owned baseline keys and preserved injected hooks
- [x] Desktop shell: Noctalia + rofi launcher + Polkit agent + lock/idle behavior + Hyprsunset night light
- [x] Migrate i3 workflow: workspaces, focus/move/resize, audio, launcher, session controls
- [x] Desktop apps: Todoist, Calibre, Zotero, Slack, Discord, Spotify
- [x] Jujutsu
- [x] git identity strategy (opnix-generated local include; bootstrap remains below)
- [x] Editor: shared Neovim Lua config and locked Lazy plugins on Mellon and Palantir
- [ ] prompt (starship?) + remaining shell tooling (zoxide)
- [ ] Declare a monitor option schema for connector, mode, scale, position, and workspace
- [ ] Add Mellon kanshi profiles after monitor connector names are known

## Tooling / CI

- [x] Allow direct-checkout work in this repository and ignore `.worktrees/`
- [x] Pin Codex 0.156.1 and Herdr 0.9.1 (2026-09-23)
- [x] Herdr 0.9.3, Codex 0.162.0, Claude Code 2.1.295 (2026-10-09)
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

## mithril — personal macbook (later)

- [ ] Create the personal Darwin host using the shared palantir foundation
- [ ] homebrew module if an application is unavailable or unsuitable through nixpkgs
- [ ] Karabiner/Hammerspoon-style key remaps (ref: fersilva16 darwin modules)

## Someday / maybe

- [x] Snapper timeline on root `@` (separate mounts and home deliberately excluded)
- [ ] Off-machine backup destination and tested restore procedure for `/home`
- [ ] Theming namespace (colors/fonts shared across NixOS + HM)
- [ ] Per-host activation apps (`nix run '.#nixosActivations/mellon'`)

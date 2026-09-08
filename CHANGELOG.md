# Changelog

All notable changes to this nixcfg are tracked here, newest first.
Date-based entries with [Keep a Changelog](https://keepachangelog.com/)
categories (Added / Changed / Fixed / Removed) — dotfiles don't semver.
Add user-facing changes under `[Unreleased]`; move them to a dated header
whenever it feels like a checkpoint.

## [Unreleased]

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

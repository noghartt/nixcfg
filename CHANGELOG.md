# Changelog

All notable changes to this nixcfg are tracked here, newest first.
Date-based entries with [Keep a Changelog](https://keepachangelog.com/)
categories (Added / Changed / Fixed / Removed) — dotfiles don't semver.
Add user-facing changes under `[Unreleased]`; move them to a dated header
whenever it feels like a checkpoint.

## [Unreleased]

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

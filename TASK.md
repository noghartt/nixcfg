# TASK.md

Working checklist for the nixcfg rebuild. Keep this file updated as items land.

## Foundation

- [x] Fix flake.nix (`outputs`, `nixosConfigurations`, `follows`)
- [x] lib helpers: `mapDir` (directory-driven hosts) + `mkNixOSConfig`
- [x] Foundry layout: `hosts/{common,<host>}` + `home/<user>/{user.nix,home.nix,features,<host>.nix}`
- [x] Host specs: `mkNixOSConfig` maps host fields (`users`, `imports`) into modules; overridable user factories (call / `overrideAttrs`)
- [x] Custom option-only modules (`device.type`) auto-imported into NixOS + HM
- [x] home-manager as NixOS module; per-host HM entrypoint keyed by `networking.hostName`
- [x] devShell (nixd, nixfmt, statix, deadnix) + `nix fmt` formatter

## mellon — NixOS desktop

- [x] NVIDIA Blackwell module (adapted from fersilva16/nix-config)
- [x] disko: ESP + LVM (root 500G / home 1T btrfs, ~300G free in VG, unencrypted) + 64G swapfile
- [x] Kernel: `linuxPackages_latest` (RTL8922AE needs 7.x; Blackwell suspend caveat in hardware.nix)
- [x] Boot: systemd-boot (NixOS has no native EFISTUB) + systemd initrd + LVM
- [x] Desktop: Hyprland (Wayland) + greetd + pipewire + bluetooth
- [x] `time.timeZone` (America/Sao_Paulo)
- [ ] Install day: `sudo disko --mode disko --flake .#mellon` from the installer, then `nixos-install --flake .#mellon`
- [ ] Install day: replace placeholder `hardware-configuration.nix` with `nixos-generate-config` output
- [ ] Install day: set `resume_offset` in hosts/mellon/boot.nix (`sudo btrfs inspect-internal map-swapfile -r /swap/swapfile`) and rebuild — enables hibernation
- [ ] Gaming: steam + gamemode (32-bit graphics already enabled by the NVIDIA module)

## Home Manager

- [x] Terminal (ghostty) + zsh (autosuggestion, syntax-highlighting)
- [x] cli tooling: eza, bat, fd, fzf, lazygit + browsers (firefox, chrome)
- [ ] git identity strategy (no PII in repo — local include or override), ssh config
- [x] editor (neovim, bare — plugins/config to grow)
- [ ] prompt (starship?) + remaining shell tooling (direnv, zoxide)

## Tooling / CI

- [ ] treefmt: nixfmt + statix + deadnix wired as `checks.formatting`
- [ ] CI: build `nixosConfigurations` on push
- [ ] Generation labels (`system.nixos.label` with rev) + `/etc` breadcrumb symlinks (lucasew pattern)
- [ ] Secrets: decide sops-nix (age key derived from host SSH key — Misterio77 pattern) vs 1Password SSH agent (fersilva16 pattern)

## mithril — macbook (later)

- [ ] nix-darwin input + `mkDarwinConfig` helper
- [ ] Second nixpkgs branch (`nixpkgs-unstable` for darwin, keep `nixos-unstable` for NixOS)
- [ ] homebrew module + macOS system defaults
- [ ] Karabiner/Hammerspoon-style key remaps (ref: fersilva16 darwin modules)

## Someday / maybe

- [ ] Impermanence (Misterio77 opt-in pattern: `optin-persistence.nix` + `ephemeral-btrfs.nix`)
- [ ] Theming namespace (colors/fonts shared across NixOS + HM)
- [ ] Per-host activation apps (`nix run '.#nixosActivations/mellon'`)
- [ ] `monitors` option + kanshi per-host files

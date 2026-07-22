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

- [x] Host skeleton (systemd-boot, NetworkManager, user creation)
- [x] NVIDIA Blackwell module (adapted from fersilva16/nix-config)
- [ ] Replace placeholder `hardware-configuration.nix` with `nixos-generate-config` output on the real machine
- [ ] disko layout: LUKS + btrfs (`@`, `@home`, `@nix`, zstd+noatime), zram instead of swap; TPM2 auto-unlock optional (ref: fersilva16 `polaris-disk.nix`)
- [ ] Kernel decision: default vs `linuxPackages_latest` — check WiFi NIC first (RTL8922AE needs latest, but Blackwell suspend-to-idle hangs on newest kernels)
- [ ] `time.timeZone` + i18n locale
- [ ] Desktop environment: pick one — niri+Noctalia (fersilva16's stack) / Hyprland / GNOME
- [ ] Audio (pipewire) + Bluetooth
- [ ] Dual boot: systemd-boot windows entry + `time.hardwareClockInLocalTime` (if keeping Windows)
- [ ] Gaming: steam + gamemode (32-bit graphics already enabled by the NVIDIA module)

## Home Manager

- [ ] cli feature: git identity strategy (no PII in repo — local include or override), shell, ssh
- [ ] editor (neovim?) + terminal (ghostty?)
- [ ] prompt / shell tooling (eza, fzf, direnv, zoxide)

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

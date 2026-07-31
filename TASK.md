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
- [x] disko: ESP 2G + LUKS + LVM (root 500G / home remainder), btrfs subvolumes @ @nix @var_log @snapshots @swap + @home, 64G swapfile
- [x] Hardware stack: independently locked Linux 7.1.4 + firmware/microcode 20260622; NVIDIA 595.84 pinned in `nvidia.nix`
- [x] Boot: Lanzaboote Secure Boot + systemd initrd + encrypted LVM
- [x] Desktop: Hyprland (Wayland) + greetd + pipewire + bluetooth
- [x] `time.timeZone` (America/Sao_Paulo)
- [ ] Install day: follow `INSTALL.md` exactly (destructive Disko, temporary LUKS secret, hardware config, Lanzaboote keys, login password)
- [ ] Install day: set `resume_offset` in hosts/mellon/boot.nix (`sudo btrfs inspect-internal map-swapfile -r /swap/swapfile`) and rebuild — enables hibernation
- [ ] Install day: after passphrase and Secure Boot validation, enroll TPM2 LUKS unlock with a PIN and test passphrase fallback
- [ ] Pre-install decision: keep a persistent root or add Foundry-style impermanence (requires a Disko persistence subvolume and explicit state inventory)
- [x] docker + compose (daemon on the host, `docker` group via user factory `overrideAttrs`, NVIDIA container toolkit)
- [x] Reliability: SMART monitoring + desktop notifications, weekly fstrim, power-profiles-daemon, bounded journal/Docker growth, root Snapper timeline
- [x] Networking: NetworkManager + RTL8922AE desktop tuning, Brazilian regulatory domain, systemd-resolved, native firewall, Tailscale, Cloudflare WARP, Wireshark capture
- [x] NVIDIA suspend/hibernate VRAM preservation (resume offset still pending install day)
- [x] Gaming: Steam + GameMode (32-bit graphics already enabled by the NVIDIA module)
- [ ] Verify the work WARP profile uses traffic-only mode and excludes Tailscale IPv4/IPv6 ranges

## Home Manager

- [x] Terminal: Ghostty auto-attached to persistent tmux + zsh (autosuggestion, syntax-highlighting)
- [x] cli tooling: eza, bat, fd, fzf, lazygit + browsers (firefox, chrome)
- [x] AI coding agents: Claude Code, Codex, OpenCode, Pi + pi-claude-bridge
- [x] Claude Bash/subagent sandbox with explicit approval for unsandboxed retries
- [x] Desktop shell: Noctalia + rofi launcher + Polkit agent + lock/idle behavior + Hyprsunset night light
- [x] Migrate i3 workflow: workspaces, focus/move/resize, audio, launcher, session controls
- [x] Desktop apps: Todoist, Calibre, Zotero, Slack, Discord, Spotify
- [x] Jujutsu
- [x] git identity strategy (opnix-generated local include; bootstrap remains below)
- [x] editor (neovim, bare — plugins/config to grow)
- [ ] prompt (starship?) + remaining shell tooling (zoxide)
- [ ] Declare a monitor option schema for connector, mode, scale, position, and workspace
- [ ] Add Mellon kanshi profiles after monitor connector names are known

## Tooling / CI

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
- [ ] Declare secrets as env vars in `home/noghartt/features/cli/secrets-env.nix` as tools need them

## palantir — work macbook

- [x] nix-darwin input + `mkDarwinConfig` helper
- [x] Second nixpkgs branch (`nixpkgs-unstable` for Darwin, keep `nixos-unstable` for NixOS)
- [x] Directory-discovered Darwin hosts + build checks
- [x] Cross-platform user factory with independent HM and nix-darwin state versions
- [x] Palantir host composition reusing Mellon's Chrome, Firefox, Ghostty, and Claude Code configuration
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

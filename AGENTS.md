# AGENTS.md

Unified NixOS + home-manager flake (nix-darwin foundation, host planned).
Hosts are named after Lord of the Rings names/artifacts: lowercase, short, hostname-safe.
Layout follows [Misterio77/Foundry](https://github.com/Misterio77/Foundry).

## Hosts

| Host | Type | Hardware |
| --- | --- | --- |
| `mellon` | NixOS desktop | AMD CPU, NVIDIA RTX 5070 Ti (Blackwell) |

## Layout

```
flake.nix                    inputs + outputs only; hosts directory-discovered via lib/mapDir
lib/                         mapDir, mkNixOSConfig, mkDarwinConfig
modules/nixos/               custom NixOS options — OPTION-ONLY, auto-imported into every host
modules/home-manager/        custom HM options — OPTION-ONLY, auto-imported into every user
hosts/common/global/         imported by every host (nix settings, home-manager wiring)
hosts/common/optional/       opt-in system modules shared by 2+ hosts (created when needed)
hosts/<host>/                default.nix = host SPEC (function over { users, lib },
                             mapped by mkNixOSConfig) + host modules (mellon: disk, boot,
                             hardware, nvidia, desktop) + hardware-configuration.nix (generated)
home/<user>/user.nix         user factory: overridable (functor + overrideAttrs) NIXOS module
home/<user>/home.nix         default HM config, imported on every host
home/<user>/features/cli/    shared shell/dev tools; agents/ holds Claude, Codex, OpenCode
home/<user>/features/desktop/ portable desktop default + platform-specific modules
home/<user>/features/pi/     standalone Pi feature: settings + packaged extensions
home/<user>/<host>.nix       optional per-host HM overrides
TASK.md                      living checklist of planned work — keep it updated
INSTALL.md                   destructive install + LUKS/Secure Boot runbook
```

## Conventions

- Host files are host SPECS consumed by `mkNixOSConfig`, not plain NixOS modules:
  functions of `{ users, lib, ... }` returning fields. `users` lists user factories
  (flake output `users`, auto-discovered from `home/<user>/user.nix`): bare name for
  defaults, `(name { ... })` to replace fields, `name.overrideAttrs (old: { ... })`
  to extend the defaults. `imports` holds inner modules;
  everything else passes through as NixOS config. `mkNixOSConfig` maps the resolved
  users into the host's module list.
- Custom options (`device.*`, future `monitors.*`, ...) live in `modules/{nixos,home-manager}/`
  and declare options ONLY — never config. NixOS side: auto-imported by `mkNixOSConfig`.
  HM side: auto-imported via `home-manager.sharedModules`. Same namespace on both sides.
- Users are colocated in `home/<user>/`: `user.nix` is an overridable factory
  (functor attrset with `__functor` + `overrideAttrs`, nixpkgs-style) — the only
  NixOS-level file there; everything else in that dir is HM config. It always imports
  `./home.nix`, plus `./<host>.nix` when it exists, and forwards `inherit (config) device;`
  into HM. Overrides are how one host customizes the user without touching the shared files.
- Hardware-specific modules live in the host dir (e.g. mellon's `nvidia.nix`); promote to
  `hosts/common/optional/` only when a second host needs them.
- HM features are import-based (`home/<user>/features/<area>/`), not enable-flag-based.
  Portable baseline areas are imported by `home.nix`; platform features are composed by the
  user host entrypoint. Do not nest a substantial feature under `cli/` merely because its
  executable is a CLI. Use a directory when a feature has multiple concerns, as Pi does for
  core settings and packaged extensions. Optional system modules use the same plain-file
  pattern in `hosts/common/optional/`.
- Platform composition stays at the user host entrypoint: `home.nix` imports the portable
  baseline, while `<host>.nix` combines portable desktop features with the platform-specific
  modules it needs. `desktop/default.nix` must remain evaluable on both Linux and Darwin;
  platform-only integrations are imported directly by the corresponding host entrypoint.
- AI harnesses use their native Home Manager modules. Claude Code, Codex, and OpenCode remain
  small per-harness modules under `features/cli/agents/`; Pi is a standalone feature because it
  owns model settings and Nix-packaged extensions.
- Modules access flake inputs/outputs through the `flake` specialArg (`flake.inputs.x`,
  `flake.outputs.x`), never by importing `../flake.nix`.
- `hardware-configuration.nix` is machine-generated (`nixos-generate-config`); do not hand-edit.
- `nixpkgs` tracks `nixos-unstable` for userspace. `nixpkgs-hardware` is independently
  locked and supplies mellon's kernel build stack, Linux firmware, wireless regulatory
  data, and AMD microcode. The NVIDIA version and source hashes are pinned in the host's
  `nvidia.nix` via that kernel package set's `mkDriver`. Update either only as a deliberate,
  separately tested hardware-stack change. The Darwin constructor exists, but the macbook
  still needs a dedicated nixpkgs branch and cross-platform user adapter — see TASK.md.
- No frameworks (flake-parts, blueprint, den, ...). Vanilla `nixpkgs.lib` + `lib/`.
- Extra inputs and why: `disko` (declarative disk layout for mellon),
  `lanzaboote` (Secure Boot signing and systemd-boot integration),
  `nixpkgs-hardware` (independently locked kernel/firmware package set),
  `nixos-hardware` (upstream hardware quirks; Mellon uses its Blackwell module),
  `nix-darwin` (Darwin system constructor; first host wiring is still pending),
  `firefox-addons` (rycee's packaged Firefox extensions, used by the desktop feature),
  `opnix` (1Password secrets — see Hard rules), `noctalia` (native desktop shell and
  its Home Manager module, newer than the legacy nixpkgs package).

## Commands

- `nixfmt <file>` — format nix files (rfc-style). Do NOT use `nix fmt`: with Determinate Nix +
  nixfmt 1.4 it mis-invokes nixfmt and has already corrupted a file once (moved an attribute
  between attrsets). Format per-file, then check `git diff`.
- `nix eval .#nixosConfigurations.mellon.config.system.build.toplevel.drvPath` — cheap eval smoke test
- `nix flake check` — full evaluation (builds; slow)
- `sudo nixos-rebuild switch --flake .#mellon` — apply on the host
- `nix flake update` — bump inputs; review the `flake.lock` diff after
- `nix flake update nixpkgs` — update userspace without moving mellon's hardware stack
- `nix flake update nixpkgs-hardware` — deliberately update the hardware stack

## Style

- nixfmt-rfc-style formatting; keep statix- and deadnix-clean.
- Comments explain *why* (hardware quirks, workarounds, tradeoffs), never *what*.
- Small files, one concern per file. If a host file grows past ~80 lines, something belongs
  in `hosts/common/` or a feature dir.

## Commit messages

Conventional commits: `type(scope): description` (adapted from Foundry)

- `type`: `feat`, `fix`, `refactor`, `docs`, `chore`, `WIP`
- `scope`: path-based, reflecting what changed:
  - `home/<user>` or `home/<user>/<feature>` for user config: `home/noghartt`, `home/noghartt/cli`
  - `<host>` or `<host>/<module>` for host-specific: `mellon`, `mellon/nvidia`
  - just the component for shared code: `lib`, `modules`, `hosts/common`, `flake`
- Message is lowercase, no period at end.
- `flake.lock` bumps: summarize what actually changed upstream (short hash range + bullet
  list of meaningful commits), so the diff is reviewable without leaving the repo.
- Record notable changes in CHANGELOG.md under `[Unreleased]` (date-based entries,
  Added/Changed/Fixed/Removed), and date-stamp them at checkpoints.

## Reference configs

Patterns here are adapted from:

- [Misterio77/Foundry](https://github.com/Misterio77/Foundry) — overall layout, hostname-keyed HM entrypoints, option-only custom modules, Pi configuration
- [fersilva16/nix-config](https://github.com/fersilva16/nix-config) — NVIDIA Blackwell module, RTL8922AE kernel notes, disk layout and tmux references
- [thiagokokada/nix-configs](https://github.com/thiagokokada/nix-configs) — `mapDir` outputs
- [lucasew/nixcfg](https://github.com/lucasew/nixcfg) — generation labels, `/etc` breadcrumbs (later)

## Hard rules

- Never commit secrets. Strategy: 1Password via opnix — user secrets as
  `programs.onepassword-secrets` (HM), system secrets as `services.onepassword-secrets`
  (NixOS, add when first needed). The service-account token lives outside the repo
  (`~/.config/opnix/token`, provisioned with `opnix token set`); never commit it.
- No personal data in the repo: no real names, emails, or other PII in any file
  (git identity, SSH config with personal hosts, etc. stay local).
- Don't add flake inputs without a documented reason (note it in this file).
- Don't run `nixos-rebuild switch` autonomously; evaluate only, let the user apply.
- Update this file and TASK.md whenever structure or conventions change.

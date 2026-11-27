# AGENTS.md

Unified NixOS + nix-darwin + home-manager flake.
Hosts are named after Lord of the Rings names/artifacts: lowercase, short, hostname-safe.
Layout follows [Misterio77/Foundry](https://github.com/Misterio77/Foundry).

## Hosts

| Host | Type | Hardware |
| --- | --- | --- |
| `mellon` | NixOS desktop | AMD CPU, NVIDIA RTX 5070 Ti (Blackwell) |
| `palantir` | nix-darwin work laptop | Apple M5 MacBook Pro |
| `mithril` | nix-darwin personal laptop | Apple M4 Pro MacBook Pro |

## Layout

```
flake.nix                    inputs + outputs only; hosts directory-discovered via lib/mapDir
config/neovim/               portable Neovim config + Home Manager integration
lib/                         mapDir, mkNixOSConfig, mkDarwinConfig
modules/nixos/               custom NixOS options — OPTION-ONLY, auto-imported into every host
modules/home-manager/        custom HM options — OPTION-ONLY, auto-imported into every user
overlays/                    shared nixpkgs overlays applied to every host
hosts/common/global/         imported by every NixOS host (nix settings, HM wiring)
hosts/common/darwin/         imported by every Darwin host (nix settings, HM wiring)
hosts/common/optional/       opt-in system modules shared by 2+ hosts (macbook.nix: casks, defaults for both Macs)
hosts/common/local.nix       per-machine private additions, imported by every host; committed empty, edited only under git skip-worktree
hosts/<host>/                host specs, routed to mkNixOSConfig or mkDarwinConfig
home/<user>/user.nix         cross-platform user factory (functor + overrideAttrs)
home/<user>/home.nix         portable HM baseline imported on every host
home/<user>/features/cli/    shared shell/dev tools; agents/ holds Claude, Codex, OpenCode, agent-path gh shim, shared skills (skills.nix; own ones in skills/, e.g. pr-babysit, rex-workflows)
home/<user>/features/desktop/ portable desktop default + platform-specific modules
home/<user>/features/herdr/  standalone Herdr feature: native HM settings + pinned package
home/<user>/features/pi/     previous Pi setup: settings + packaged extensions OmO inherits; no longer installs `pi`
home/<user>/features/pi-next/ `pi` on a hand-managed agent dir (`~/.config/pi/agent`); Nix links only extensions/ (antigravity, rex) and skills/ (cli/agents/skills.nix)
home/<user>/features/pi-durable/ `pi-durable`: durable (SQLite) agent with pi's TUI, skills and /tree, built on Pi's Durable library; subagent profiles, parallel fan-out, /swarm (coordinator + workers on any profile, Antigravity included, on a shared board), worktrees, sbx sandboxes (sandbox-isolated subagents, `--sandbox`/`/sandbox` sessions, `sandbox_run`/`sandbox_pull`; links the sbx library as `#sbx/*`), watchers, cross-session messaging, dashboard, /btw side questions, /status (limits, daily usage), Claude multi-account fallback on usage limits (`pi-durable accounts`, `/accounts` also signs in to other providers); src/ + tests/ + package.nix + agents/ (per-model subagent profiles, incl. Antigravity runner) (all hosts)
home/<user>/features/omo/    standalone OmO Native (`omo`) feature: own agent dir, model chains, memory guards (palantir, mithril, mellon)
home/<user>/features/vscode/ standalone VS Code feature: marketplace extensions + live settings.json
home/<user>/features/cua/    standalone Cua Driver feature: pinned app + daemon, skill and docs MCP for harnesses (palantir, mithril)
home/<user>/features/darwin/  shared Mac composition (apps, agent stack, Ghostty+Herdr) imported by palantir.nix and mithril.nix
home/<user>/features/hashcards/ standalone hashcards (spaced repetition) CLI, built from source; bump package.nix (all hosts)
home/<user>/features/git-twig/  standalone `git twig` (CoW linked worktrees), built from source; skill linked into every harness, every worktree creator goes through it (all hosts)
home/<user>/features/sandbox/ standalone `sbx`: provider-agnostic sandboxes (provider interface + contract tests, VM kinds, git seed/pull), exe.dev provider on @exedev/sdk, hourly reaper; `src/testing.ts` exports the fake provider for consumers' tests (all hosts)
home/<user>/features/agent-evals/ standalone eval pipeline: `aeval` ingest/label/classify/report/export/replay over session transcripts (both hosts)
home/<user>/features/pi/extensions/agent-forum/  agent forum client tools (forum_*), loaded by Pi only
hosts/mellon/agent-forum/    agent forum service (Bun + SQLite) and its VM test
home/<user>/<host>.nix       optional per-host HM overrides
TASK.md                      living checklist of planned work — keep it updated
INSTALL.md                   destructive install + LUKS/Secure Boot runbook
DARWIN.md                    Darwin bootstrap and activation runbook
docs/                        per-feature design notes (read the matching doc before changing a feature)
```

## Conventions

- Host files are host SPECS consumed by `mkNixOSConfig` or `mkDarwinConfig`, not plain modules:
  functions of `{ users, lib, ... }` returning fields. `users` lists user factories
  (flake output `users`, auto-discovered from `home/<user>/user.nix`): bare name for
  defaults, `(name { ... })` to replace fields, `name.overrideAttrs (old: { ... })`
  to extend the defaults. `imports` holds inner modules;
  everything else passes through as system config. Both constructors map the resolved
  users into the host's module list.
- Custom options (`device.*`, future `monitors.*`, ...) live in `modules/{nixos,home-manager}/`
  and declare options ONLY — never config. NixOS side: auto-imported by `mkNixOSConfig`.
  HM side: auto-imported via `home-manager.sharedModules`. Same namespace on both sides.
- Users are colocated in `home/<user>/`: `user.nix` is a cross-platform overridable
  system module factory (functor attrset with `__functor` + `overrideAttrs`, nixpkgs-style);
  everything else in that dir is HM config. It imports `./home.nix` and `./<host>.nix` when
  present, and forwards `inherit (config) device;` into HM.
  Home Manager's string state version is independent of nix-darwin's integer state version.
- Mellon is an always-on agent host: system sleep is refused (`power.nix`), sshd is key-only
  and reachable only on `tailscale0` (`ssh.nix`, `~/.ssh/authorized_keys` kept by hand, not by Nix,
  `~/.ssh/rc` keeps a forwarded agent for long-lived shells), Docker publishes ports on
  loopback, and the native NixOS firewall owns the rules (nixpkgs has no ufw). Git reaches
  GitHub with a dedicated key (`github-ssh.nix`; opnix writes `~/.ssh/github_mellon` from the
  `Nix/mellon-github` SSH Key item, GitHub's host key is pinned), so unattended runs can push;
  every other SSH connection still signs through the desktop 1Password agent, which asks on
  screen for each new client and locks after an idle hour.
- `hosts/common/local.nix` is committed as `{ nixos = { }; darwin = { }; }` (lib imports the half
  matching each host's platform) and must stay that empty stub in git. A machine
  that needs private, uncommitted additions runs `git update-index --skip-worktree` on it and
  edits it in place: git keeps reporting the stub (no diff, never staged), while Nix reads the
  working tree, so a plain `--flake .#<host>` rebuild applies the edits. Never stage, commit, or
  describe its local contents; it cannot add flake inputs, so it pins any external flake with
  `builtins.getFlake` on a locked URL (with `narHash`).
- Hardware-specific modules live in the host dir (e.g. mellon's `nvidia.nix`); promote to
  `hosts/common/optional/` only when a second host needs them.
- Package overrides shared by Linux and Darwin live in `overlays/` and are applied by both
  common host modules. Pi comes from nixpkgs unmodified; `pi-durable` is our own app on the
  Durable library inside that Pi package (`features/pi-durable/`), marked broken when Pi moves
  past its `verifiedPiVersion` (see `docs/pi-durable.md`).
  `overlays/ghostty.nix` (Darwin only) keeps `ghostty-bin` at a release newer than the
  locked `nixpkgs-darwin` and steps aside once the lock reaches that version.
  `overlays/opencode.nix` (Darwin only) replaces opencode 2.2.5's stale `node_modules` hash
  (NixOS/nixpkgs#582673) and steps aside once nixpkgs changes it.
  `overlays/grok-bot.nix` (NixOS only) repackages Cursor's Grok Bot Electron app from the
  vendor's .deb (autoPatchelf + Wayland wrapper); Mellon installs it through Home Manager.
  `overlays/claude-desktop.nix` (NixOS only) does the same for Anthropic's Claude Desktop
  Linux beta from its apt repository's .deb (the Macs use the `claude` cask); it never
  self-updates on Linux, so bump its version and hash by hand. Cowork's QEMU/KVM is not wired.
- HM features are import-based (`home/<user>/features/<area>/`), not enable-flag-based.
  Portable baseline areas are imported by `home.nix`; platform features are composed by the
  user host entrypoint. Do not nest a substantial feature under `cli/` merely because its
  executable is a CLI. Native application config that should remain independent of a user or
  host can live under `config/`, as Neovim does. Use a directory when a feature has multiple
  concerns, as Pi does for core settings and packaged extensions. Optional system modules use
  the same plain-file pattern in `hosts/common/optional/`. Herdr is also standalone:
  Home Manager owns its core settings. Plugins without upstream module options can be
  packaged as immutable local plugins and registered idempotently with `herdr plugin link`
  during activation; their configuration and state remain writable runtime data.
  Plugin bundles without user-facing executables stay out of `home.packages`:
  activation references retain them without merging their manifests into the user profile.
- Platform composition stays at the user host entrypoint: `home.nix` imports the portable
  baseline, while `<host>.nix` combines portable desktop features with the platform-specific
  modules it needs. `desktop/default.nix` must remain evaluable on both Linux and Darwin;
  platform-only integrations are imported directly by the corresponding host entrypoint.
- The writable checkout is conventionally `~/www/nixcfg`, exposed as `$NIXCFG`; the `nixcfg`
  shell alias changes to it. Store paths remain the source of evaluated configuration.
- Hosts declare their own platform via `nixpkgs.hostPlatform` (mellon: in
  `hardware-configuration.nix`); `mkNixOSConfig`/`mkDarwinConfig` take no `system`.
  A `*-darwin` hostPlatform declared in the spec itself routes that hosts/
  directory to `mkDarwinConfig` during discovery, so Darwin hosts must set it
  inline; NixOS hosts may keep it in `hardware-configuration.nix`.
  Per-system flake outputs (checks, devShells, formatter) come from `forAllSystems`
  over the `systems` list in flake.nix — extend that list for a new platform. Each
  host's build check lands in its own platform's check set.
- Modules access flake inputs/outputs through the `flake` specialArg (`flake.inputs.x`,
  `flake.outputs.x`), never by importing `../flake.nix`.
- `hardware-configuration.nix` is machine-generated (`nixos-generate-config`); do not hand-edit.
- `nixpkgs` tracks `nixos-unstable` for NixOS, while `nixpkgs-darwin` tracks
  `nixpkgs-unstable` for macOS. `nixpkgs-hardware` is independently
  locked and supplies mellon's kernel build stack, Linux firmware, wireless regulatory
  data, and AMD microcode. The NVIDIA version and source hashes are pinned in the host's
  `nvidia.nix` via that kernel package set's `mkDriver`. Update either only as a deliberate,
  separately tested hardware-stack change. Palantir uses the Darwin branch through nix-darwin.
- No frameworks (flake-parts, blueprint, den, ...). Vanilla `nixpkgs.lib` + `lib/`.
- Extra inputs and why: `disko` (declarative disk layout for mellon),
  `lanzaboote` (Secure Boot signing and systemd-boot integration),
  `nixpkgs-hardware` (independently locked kernel/firmware package set),
  `nixos-hardware` (upstream hardware quirks; Mellon uses its Blackwell module),
  `nix-darwin` (Darwin system constructor for palantir and mithril),
  `nix-homebrew` (declarative, pinned Homebrew installation on Darwin; casks are
  declared via nix-darwin's `homebrew` module with cleanup enabled),
  `brew-src` (temporary override of nix-homebrew's brew pin — cask definitions
  are served live by the formulae API, so brew must stay new enough for their
  DSL; drop when upstream's pin catches up),
  `firefox-addons` (rycee's packaged Firefox extensions, used by the desktop feature),
  `nix-vscode-extensions` (full VS Code Marketplace as Nix packages, used by
  the standalone vscode feature; no `follows` — prebuilt against its own pin),
  `opnix` (1Password secrets — see Hard rules), `noctalia` (native desktop shell and
  its Home Manager module, newer than the legacy nixpkgs package), `herdr` (official,
  release-pinned source build of the terminal workspace manager).

## Feature docs

Feature-level design lives in `docs/`, which is not loaded automatically: read the matching doc
before changing a feature, and update it in the same change.

- `docs/sandbox.md`: `sbx` sandboxes: provider interface, kinds, exe.dev provider, auth, git flow, reaper, adding a provider, consumers.
- `docs/herdr.md`: Herdr launch from Ghostty, saved machines, plugins and keybindings.
- `docs/rex.md`: Rex (replaces Herdr): program status and session context from `pi` and pi-durable.
- `docs/git-twig.md`: CoW worktrees, and every place (pi-durable, Pi extensions, Herdr patch, Claude hooks) that creates them.
- `docs/pi-durable.md`: the Durable agent, its TUI (skills, /tree branches, labels, sessions, dashboard, /swarm), agent tools
  (profiles, subagent, parallel, watch, agents, sessions), sandboxes (sbx ExecutionEnv, sandbox subagents and sessions), re-porting.
- `docs/deep-research.md`: `/research` runs in pi-durable (Exa/Kagi tools, headless Chrome fallback, researcher profiles, plain-folder reports).
- `docs/omo.md`: harness modules, agent-path `gh` shim, OmO settings, model chains, memory guards.
- `docs/orchestrator.md`: leader + worker runs, graph, placement, leader tools.
- `docs/statusline.md`: footer, sidebar, limits.
- `docs/destructive-guard.md`: approval layers.
- `docs/omo-ui.md`: ui-prompt and ui-chrome, OmO version guard.
- `docs/agent-evals.md`: `aeval` ingest, labelling, reports, export, replay.
- `docs/agent-forum.md`: forum service and client tools.
- `docs/extensions.md`: herdr-fork, findings-cache and antigravity (`agy` sub-agent).
- `docs/cloud-mode.md`: `--cloud` over SSH, `publish`.

## Commands

- `nixfmt <file>` — format nix files (rfc-style). Do NOT use `nix fmt`: with Determinate Nix +
  nixfmt 1.4 it mis-invokes nixfmt and has already corrupted a file once (moved an attribute
  between attrsets). Format per-file, then check `git diff`.
- `nix eval .#nixosConfigurations.mellon.config.system.build.toplevel.drvPath` — cheap eval smoke test
- `nix eval .#darwinConfigurations.palantir.system.drvPath` — Darwin eval smoke test (same for `mithril`)
- `nix flake check` — full evaluation (builds; slow)
- `sudo nixos-rebuild switch --flake .#mellon` — apply on the host
- `sudo darwin-rebuild switch --flake .#palantir` — apply on the Mac after bootstrap (`.#mithril` on the personal one)
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

- Work directly in this checkout; dedicated worktrees are not required for this
  repository. This overrides the general worktree-by-default rule. Preserve
  unrelated edits, and keep any existing `.worktrees/` directories git-ignored.
- Never commit secrets. Strategy: 1Password via opnix — user secrets as
  `programs.onepassword-secrets` (HM), system secrets as `services.onepassword-secrets`
  (NixOS, none yet). The service-account token lives
  outside the repo (`~/.config/opnix/token` for HM, `/etc/opnix-token` for NixOS once one exists,
  provisioned with `opnix token set`); never commit it.
  Shell environment secrets are declared by reference in
  `home/noghartt/features/cli/secrets-env.nix` and resolved at interactive zsh startup,
  cached for 4h in a 0700 per-user runtime dir (`$XDG_RUNTIME_DIR` or `$TMPDIR`,
  `opnix-env-$UID/`) because each `opnix env` call takes ~4s; stale values are served
  while a background refresh runs. New mappings require configuration activation and a new shell; adding a vault
  item alone does not export it. Never resolve secret values during Nix evaluation.
- No personal data in the repo: no real names, emails, or other PII in any file
  (git identity, SSH config with personal hosts, etc. stay local).
- Don't add flake inputs without a documented reason (note it in this file).
- Always pull the latest changes: run `git pull --rebase --autostash` before starting any
  change, and again right before committing or pushing. The config is shared across
  machines and people, edits from elsewhere land on the remote, and conflicts are cheapest
  before local work piles up. If the pull conflicts, stop and resolve it (or ask) before
  continuing; never force-push over remote work. Push finished commits promptly so others
  pull them too.
- Don't run `nixos-rebuild switch` or `darwin-rebuild switch` autonomously; evaluate only,
  let the user apply.
- Update this file and TASK.md whenever structure or conventions change.

# AGENTS.md

Unified NixOS + nix-darwin + home-manager flake.
Hosts are named after Lord of the Rings names/artifacts: lowercase, short, hostname-safe.
Layout follows [Misterio77/Foundry](https://github.com/Misterio77/Foundry).

## Hosts

| Host | Type | Hardware |
| --- | --- | --- |
| `mellon` | NixOS desktop | AMD CPU, NVIDIA RTX 5070 Ti (Blackwell) |
| `palantir` | nix-darwin work laptop | Apple M5 MacBook Pro |

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
hosts/common/optional/       opt-in system modules shared by 2+ hosts (created when needed)
hosts/<host>/                host specs, routed to mkNixOSConfig or mkDarwinConfig
home/<user>/user.nix         cross-platform user factory (functor + overrideAttrs)
home/<user>/home.nix         portable HM baseline imported on every host
home/<user>/features/cli/    shared shell/dev tools; agents/ holds Claude, Codex, OpenCode, agent-path gh shim
home/<user>/features/desktop/ portable desktop default + platform-specific modules
home/<user>/features/herdr/  standalone Herdr feature: native HM settings + pinned package
home/<user>/features/pi/     standalone Pi feature: settings + packaged extensions
home/<user>/features/omo/    standalone OmO Native (`omo`) feature: own agent dir, model chains, memory guards (palantir, mellon)
home/<user>/features/vscode/ standalone VS Code feature: marketplace extensions + live settings.json
home/<user>/features/cua/    standalone Cua Driver feature: pinned app + daemon, skill and docs MCP for harnesses (palantir)
home/<user>/features/swarm/  standalone agent-swarm feature: `swarm` CLI/daemon, /leader + /swarms extension, sbx kit (palantir)
home/<user>/<host>.nix       optional per-host HM overrides
TASK.md                      living checklist of planned work — keep it updated
INSTALL.md                   destructive install + LUKS/Secure Boot runbook
DARWIN.md                    Darwin bootstrap and activation runbook
SWARM.md                     swarm mode: decisions, usage, architecture, sbx setup and open checks
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
  loopback, and the native NixOS firewall owns the rules (nixpkgs has no ufw).
- Mellon's agent sandboxes (`hosts/mellon/sandboxes/`) are systemd-nspawn containers, one per
  sandbox, each booted from a writable btrfs snapshot of a Nix-built base image on the `/agent`
  volume (`/agent/base/<hash>` read-only, `/agent/sandboxes/<name>`). Isolation: private user
  namespace (`--private-users=pick`, idmapped), own veth (`ve-ab-*`) on a fixed /28 of
  `10.231.0.0/16` (host `.1`, sandbox `.2`; per-sandbox runtime networkd files with DHCP server
  and masquerade, NetworkManager ignores those links), no host bind mounts, its own Nix store
  and daemon, and per-sandbox slice limits under `agentbox.slice`. The policy is in the iptables
  mangle table, which runs before every filter chain, so tailscaled's and Docker's FORWARD
  accepts cannot bypass it: new connections from a sandbox go only to public IPv4 (plus DHCP to
  the host), new connections into a sandbox come only from `tailscale0`, and there is no IPv6.
  Tailnet devices reach sandboxes directly: Mellon advertises `10.231.0.0/16` as a subnet route
  and dnsmasq (tailnet address only, hostsdir `/run/agentbox/dns`) answers
  `<name>.sandbox.internal`; the route approval and the split-DNS nameserver live in the
  Tailscale admin console. Servers inside must listen on 0.0.0.0.
  `agentbox` (group `agentbox`) is the CLI: `ls`, `ensure NAME --seed PATH` (create, cloning
  PATH's repo from a git bundle, or start), `exec`, `shell`, `collect` (branches back into the
  host repo as `sandbox/NAME/*`), `start`/`stop`, `rm`. It reaches `agentbox-root`, the only
  privileged entry point, through one sudo rule; `exec` enters the container as its uid-1000
  `agent` user inside a scope in the sandbox's slice. Only committed history crosses in either
  direction, always as bundles. `agentbox-base.service` lays down a new base when the image
  changes; existing sandboxes keep the image they were created from (recreate to upgrade).
- Hardware-specific modules live in the host dir (e.g. mellon's `nvidia.nix`); promote to
  `hosts/common/optional/` only when a second host needs them.
- Package overrides shared by Linux and Darwin live in `overlays/` and are applied by both
  common host modules. `overlays/pi.nix` keeps Pi ahead of the lock and also builds
  `pi-durable`, the experimental durable agent upstream runs only from source.
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
- Tmux and Pi's tmux helpers are opt-in imports on Mellon. Palantir launches Herdr
  directly from Ghostty. Herdr's agent tree is a Nix-packaged native popup command
  under `features/herdr/`, bound to `Alt+A`; it uses live session metadata and pane IDs.
  The `pr-tree/` plugin provides `Alt+P` for authored open GitHub PRs grouped by repo,
  using the active `gh` account, with browser and clipboard actions. The `lazygit/` plugin
  binds `Alt+R` to a lazygit popup in the focused pane's cwd, so it follows worktrees. The
  `close-worktrees/` plugin binds `Prefix Alt+D` (beside `close_workspace` on `Prefix Shift+D`)
  to a confirmation popup that closes every open linked-worktree workspace of the focused
  repo, either keeping the checkouts or removing them with `herdr worktree remove`, which
  refuses dirty ones; the primary workspace is never touched. Because Herdr owns
  `Alt+P`, the Pi/OmO command palette uses `Ctrl+P` (model cycling moves to `Shift+Ctrl+P`)
  the session tree view uses `Ctrl+T` (the thinking-block toggle moves into the palette),
  and `Ctrl+?` lists keybindings. In OmO, `ui-prompt` makes `Ctrl+X` a leader: `L` resume,
  `A` cycle the primary agent (as does `Tab` on an empty prompt), `Y` OmO's original copy
  action. Ghostty sends left
  Option as Alt so Alt chords reach Herdr and Pi, and forwards `Ctrl+?` as CSI-u.
- AI harnesses use their native Home Manager modules. Claude Code, Codex, and OpenCode remain
  small per-harness modules under `features/cli/agents/`; Pi is a standalone feature because it
  owns model settings and Nix-packaged extensions. Claude's global `settings.json` is a writable
  runtime file: activation refreshes Nix-owned top-level keys while preserving tool-injected keys
  such as hooks. Cua Driver gives Pi, Claude Code, and Codex computer use: its notarized
  `CuaDriver.app` is pinned in Nix but copied to `/Applications` on activation, because macOS
  permission grants, LaunchServices, and the CLI's relaunch check key on that path. Its skill is
  pinned to the same release tag; OmO filters it out because its native `computer` tool covers
  the same ground. Telemetry and the self-updater are off; bump `features/cua/package.nix`.
  Every harness binary (Pi, `pi-durable`, OmO, Claude Code, Codex) is wrapped by
  `cli/agents/agent-path.nix` (`agentPath.wrap`, or `agentPath.prependPath` in an existing
  wrapper script) so only its process tree sees `~/.agents/bin` first on PATH. The `gh` shim
  there refuses posting GitHub comments, reviews, and comment-bearing close/reopen (subcommands,
  REST writes, GraphQL mutations); bodies and reads pass through to the real `gh`.
  OmO keeps its own agent dir (`~/.omo/agent`) but follows Pi's packaged
  extensions (minus `pi-workflows`, whose tool collides with `omo.js`), skills, and keybindings,
  plus OmO-only packages (findings-cache, cloud-mode, ui-chrome, ui-prompt) auto-discovered from
  `features/omo/extensions/<name>/` (any subdirectory
  with a `package.json`; used for extensions that hook OmO internals or OmO-only features);
  its writable `settings.json` gets the same baseline merge, including Pi's quiet startup,
  condensed changelog, and resume-hint exit output, plus `tips = false` and Nix-owned model
  defaults: Opus 5.5 at `high`, a catalog of Opus 5.5, Sonnet 5.5, Fable 5.1, and the ChatGPT
  models. OmO saves every model or thinking switch as the global default, so the `omo` launcher
  restores Opus 5.5 at `high` before each start; resumed sessions keep their own model.
  Claude Haiku 4.5 is not used anywhere (catalogs, chains, orchestrator pool). `~/.omo/omo.jsonc` is a read-only
  store link holding cross-provider model chains, with OmO's config migrations pre-recorded.
  Memory guards (one monobloco session reached 20 GB): `models.json` caps stored images at
  1568px / 750 KB for every catalog and chain model (keep its list in sync), because sessions
  keep images as encoded and rebuild each request around all of them; `~/.senpi/agent/codemode.json`
  (codemode reads `~/.senpi`, not `~/.omo`) runs JavaScript eval kernels as child processes
  (`isolation.js = "process"`, on the `bun` shim OmO puts on PATH) with a 4 GB recycle ceiling
  and 30-minute idle parking; and the `omo-memwatch` launchd agent checks omo footprints every
  30 s, writing a footprint/vmmap snapshot to `~/Library/Logs/omo-memwatch/` and notifying
  above 4 GB (again at each 1.5x growth), then stopping the process above 12 GB. On Linux
  (Mellon) memwatch is off: the `omo` launcher runs each session in a transient systemd user
  scope (`MemoryHigh` 12G, `MemoryMax` 16G), and the generic glibc release binary runs
  through nix-ld.
- The Pi `orchestrator` extension (also loaded by OmO) runs a leader + worker mesh: `orch "<goal>"`
  or `/orchestrate <goal>` sets the leader model (default Opus 5.5 at `xhigh`, `ORCH_LEADER_MODEL`
  overrides), and Jev (TypeSafe, `TYPESAFE_API_KEY`) decides control flow — strategy
  (solo/fan-out/mesh), each worker's model from the pool in `orchestrator/config.json`, and
  accept/retry/escalate gating. Acceptance is a list of criteria that Jev judges one by one against
  evidence the orchestrator collects itself (files changed since spawn, diff stat, commits, the
  worker's tool calls), not the report alone. A clear miss retries with the failing criteria, on
  the same model first and a stronger one on a repeat miss. A borderline result after a retry,
  or a blocked worker, becomes `needs_leader`, and its dependents wait for the leader's
  `orch_verdict` (which can also overrule a Jev rejection and revive skipped dependents).
  The leader plans each goal as a dependency graph: `orch_spawn`
  nodes take `after` (start once those are accepted; dependents of a failed node are skipped),
  `workdir` (run in an upstream node's worktree), and `kind: "review"` with `fixes`, where a
  `VERDICT: FAIL` reopens the reviewed node with the findings for up to `maxFixRounds` rounds;
  the reviewer's re-review, not Jev, judges a fix round.
  Pending nodes queue behind the `maxWorkers` concurrency limit.
  Inside Herdr each worker is a visible, interactive harness in its worktree workspace's root
  pane (`herdr worktree create`, under `~/.herdr/worktrees/<repo>/`, grouped under the repo's
  main workspace and branched from the leader's commit even when the leader runs in a linked
  worktree, since Herdr only creates worktrees from the main checkout); `workdir` nodes split the
  upstream worker's pane and shared-checkout nodes split the leader's, and dialogs appear in the
  worker's own pane. Outside Herdr, workers are hidden RPC children in `git worktree add`
  checkouts at the same path, and their dialogs are relayed to the leader's UI. Either way the
  leader drives workers through per-worker JSONL files in the run directory (`ctl/` for prompts,
  model switches, and stop; `events/` for ready, mesh sends, settled reports, and exit), and
  workers deliver their own mesh mail, into `mesh_wait` or as a steer. Workers never spawn or
  redirect each other, and turns a user starts in a finished worker's pane are not gated.
  Without the key it runs ungated. It publishes worker state on
  `pi.events` (`orchestrator:state`) for the statusline sidebar. Every message the
  orchestrator relays into a session (tasks, leader commands, mesh mail, leader notices) is
  prefixed `[orchestrator] ` at one delivery point, and worker and leader system prompts vouch
  for that prefix so mid-task steers are not discounted as injected text. `/agent
  [omo|orchestrator]` (or `--agent`, or the `agents:cycle` event) switches the session's primary
  agent: orchestrator mode applies the leader model, tools, and planning prompt so each typed
  request becomes a run's goal, and switching back restores the saved model; the choice persists
  as an `agents-active` session entry and is announced on `agents:active`. Workers
  (`ORCH_ROLE=worker`) always stay `omo`.
- The Pi `statusline` extension (also loaded by OmO) replaces the footer, filtering OmO's
  `"  omo-native"` badge status, and adds an OpenCode-style right sidebar column (title,
  OmO's `/goal` (its `goal`/`goal-wait` statuses plus the objective from
  `<sessionDir>/extensions/goal/<sessionId>.json`, dropped from the footer while the column is
  shown), context, session tokens with a tokens-per-turn sparkline, Claude/ChatGPT limits, agent tree,
  files edited this session with `git diff HEAD` stats, git branch/upstream/status, harness
  version). Git runs via `pi.exec` off the render path. Limits (`statusline/limits.ts`): Claude
  (5h, 7d, per-model weekly, extra-usage spend from `api/oauth/usage`, accounts with identical
  tokens deduped and pooled) and ChatGPT (`chatgpt.com/backend-api/wham/usage`). Tokens are read
  read-only from Pi's and OmO's `auth.json` and Codex CLI's `~/.codex/auth.json`, never
  refreshed. Every process shares one secret-free cache in `$TMPDIR` behind an exclusive lock
  file, so only one TUI process fetches per 5 minutes (after-turn refreshes pass the same gate),
  and failures wait out the TTL. Each provider lists its signed-in account emails (ChatGPT's
  from the token's JWT claims, Claude's from `api/oauth/profile` once per token); they stay in
  process memory, never in the shared cache. Bars carry a pace tick (even-burn position) and turn amber when
  ahead of it; a window burning at 1.1x the even rate or more adds "running hot"/"at risk" and
  the projected time it hits 100% (bands from fersilva16's config). A Todo section mirrors
  OmO's todo list (latest `senpi.todo-state` entry or `todo` result on the branch): phase
  progress, the active phase's tasks, and OmO's `todo_owed_reminder` state (`reminded n/2`,
  `stopped · N open`, cleared on user input). The statusline emits `statusline:sidebar`
  (`{ shown }`) on `pi.events`, and OmO's `ui-chrome` blanks OmO's own `todo-sidebar`
  widget above the prompt while the column is on screen. The column wraps the fullscreen TUI's layout root
  in a pi-tui `HStack`, so it only exists with `tuiMode = "fullscreen"`, which Pi's settings
  set and OmO's baseline inherits; regular mode and narrow terminals fall back to a full footer.
  Subagents come from `task` tool results and the `omo-senpi:wake` completion entries in the
  session branch; OmO exposes no task events.
- The Pi `destructive-guard` (also loaded by OmO) approves in layers: self-harm is blocked
  outright, temp-dir deletions, session-created files, and session-started processes pass
  deterministically, as do an orchestrator worker's writes, edits, and `rm` inside its own
  run-created worktree (`ORCH_WORKTREE`; the root, `.git`, and sensitive paths still ask),
  system-level categories always ask, and the rest goes to Jev with the
  session's user messages and recent tool calls; unresolved calls ask, or are refused when no UI.
  Subagents have no UI, so their writes to agent configuration (anything under `~/.omo`,
  including OmO's isolated task clones in `~/.omo/wt`, and extension sources) are refused: have
  them stage edits under `/tmp` and copy the result in from the parent session.
- OmO's opencode-style UI is two OmO-only extensions that leave the statusline's footer and
  sidebar alone. `ui-prompt` replaces the editor (public `CustomEditor`) with a card: accent bar,
  filled background, an `agent · model provider · thinking` info line that also carries the
  working indicator, and ask-user questions drawn inside the card (via the `ask-user:*` bus). It
  also sets the terminal title (session name or first prompt, cwd, busy `●`) and, inside
  Herdr, which ignores pane titles, renames its tab to the session name (only a tab still on
  Herdr's numeric default label; restored on exit), appends a
  TUI-only `▣ agent · model · duration` turn footer entry, and switches to a blinking bar
  hardware cursor for the session. Engine internals it needs (InteractiveMode's editor
  container for questions, paste state, `Editor.prototype.render`) are confined to its
  `host.ts`, guarded and `Symbol.for`-idempotent across `/reload`; recheck them on OmO bumps.
  `ui-chrome` redraws everything else, all through internals listed in its `core/host.ts`
  header (the public route cannot reach MCP/plugin tool rows or OmO's built-in screens):
  every screen OmO puts in the editor's place (extension dialogs, model/thinking pickers,
  `/tree`, `/resume`, `/settings`, `/login`, ...), `/help`, `/history`, `/hotkeys`, `/session`,
  `/changelog`, and multi-line notifies become centred modals over a faded backdrop while OmO
  keeps their keys; tool rows collapse to one header plus three output lines until Ctrl+O; user
  messages, thinking, `!cmd`, summaries, code blocks, notices, and selected widgets become
  cards. Components that must stay inline set `Symbol.for("omo-ui-chrome.inline")` (ui-prompt's
  question card does). ui-chrome re-wraps the editor container's `addChild` from OmO's original
  on `/reload`, so ui-prompt re-installs its own hook before each question.
- The `swarm` feature (Palantir; Pi package list, so OmO loads it too) runs agent swarms
  (SWARM.md). `/leader <goal>` makes the session the leader (Opus 5.5 `xhigh`, restored by
  `/leader off`) and starts a detached `swarm serve` daemon per swarm. The daemon owns
  `~/.omo/swarms/<id>/` (state, board, skills) and serves an HTTP board on 127.0.0.1. Members
  are OmO sessions, each in its own `swarm/<id>/<member>` worktree: packed into clone-mode
  `sbx` pods built from the Nix kit (`features/swarm/kit`, pinned `omo-linux-arm64`, same
  version as the host's OmO; tmux inside the pod, since `sbx exec` cannot detach), or on the
  host with `--local` as tabs of a `swarm <id>` Herdr workspace (no host tmux). Two
  patterns: `parallel` (distinct parts, shared knowledge) and `evolve` (generations scored by Jev
  and an optional fitness command, survivors seed the next generation). The daemon imports the
  orchestrator's `jev.ts`, so the CLI's source keeps the `features/` layout. Out-of-scope
  destructive member actions are held for the user; pods receive refresh-less OAuth copies that
  the leader session keeps fresh. `/swarms` is the panel; `swarm` is the CLI.
- The Pi `herdr-fork` extension (also loaded by OmO): inside Herdr, `/fork` writes the fork as a
  new session file (parent = the original, which stays untouched) and opens it in a new focused
  Herdr pane split from the current one, running the same harness with the forked message
  prefilled; `/clone` and non-Herdr sessions keep native behaviour.
- The OmO-only `findings-cache` extension saves finished `explore`/`librarian` results (foreground
  `task` results and background wake entries) to `<git-common-dir>/omo-findings/`, shared by every
  worktree of a repo, and injects a once-per-session "Cached research" index (newest 30, framed
  as leads to re-verify) into the system prompt. Reading a finding refreshes its mtime;
  findings untouched for 14 days are pruned.
- The OmO-only `cloud-mode` extension makes a session act on a remote host over SSH while OmO
  itself (TUI, models, auth, memory) stays local: `omo --cloud <host[:path]>` or
  `/cloud <host[:path]> | off`. The default directory is the same home-relative path on the
  host. `read`/`write`/`edit` are rebuilt with remote operations, `grep` runs ripgrep on the
  host, and `bash` (direct, from eval's `tool.*`, and `!`) is rewritten in `tool_call` to
  `ssh -tt` inside OmO's local PTY, so background sessions, `bash_input`, `kill_bash`, and
  `monitor` keep working. Bash gets its own connection because killing a multiplexed client
  leaves the remote process running; file operations share a ControlMaster under
  `~/.ssh/omo-cloud/`. Eval kernels stay local (the prompt confines them to `tool.*`), and LSP,
  `worktree_agents`, `apply_patch`, and computer use are switched off. A target that fails to
  resolve blocks every tool instead of falling back to local. The target persists as a
  `cloud-mode` session entry and reaches subagents through `OMO_CLOUD`, under which
  destructive-guard skips its local-disk `write`/`edit` checks. Targets need bash, ripgrep, and
  coreutils `timeout`. `--cloud <host> --sandbox[=name]` (or `/cloud <host> --sandbox`) runs
  the tools inside one of the host's `agentbox` sandboxes instead: every remote command is
  wrapped in `agentbox exec`, the sandbox is created from the host directory's repo on first
  use (default name `<repo>-<session id tail>`), and it persists until `agentbox rm`. The
  entry and `OMO_CLOUD_SANDBOX` carry the name, so resume and subagents reattach. Pass a
  name as `--sandbox=name`: a bare `--sandbox` followed by a word consumes it as the value.
  `agentbox exec` sets `AGENTBOX_HOST` (the sandbox's tailnet name), which the prompt passes on
  so the model can hand out reachable addresses.
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
  `nix-darwin` (Darwin system constructor for palantir),
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

## Commands

- `nixfmt <file>` — format nix files (rfc-style). Do NOT use `nix fmt`: with Determinate Nix +
  nixfmt 1.4 it mis-invokes nixfmt and has already corrupted a file once (moved an attribute
  between attrsets). Format per-file, then check `git diff`.
- `nix eval .#nixosConfigurations.mellon.config.system.build.toplevel.drvPath` — cheap eval smoke test
- `nix eval .#darwinConfigurations.palantir.system.drvPath` — Darwin eval smoke test
- `nix flake check` — full evaluation (builds; slow)
- `sudo nixos-rebuild switch --flake .#mellon` — apply on the host
- `sudo darwin-rebuild switch --flake .#palantir` — apply on the Mac after bootstrap
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
  (NixOS, add when first needed). The service-account token lives outside the repo
  (`~/.config/opnix/token`, provisioned with `opnix token set`); never commit it.
  Shell environment secrets are declared by reference in
  `home/noghartt/features/cli/secrets-env.nix` and resolved at interactive zsh startup.
  New mappings require configuration activation and a new shell; adding a vault
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

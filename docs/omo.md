# Harnesses and OmO

AI harnesses use their native Home Manager modules. Claude Code, Codex, and OpenCode remain
small per-harness modules under `features/cli/agents/`; Pi is a standalone feature because it
owns model settings and Nix-packaged extensions. Claude's global `settings.json` is a writable
runtime file: activation refreshes Nix-owned top-level keys while preserving tool-injected keys
such as hooks. Codex's `config.toml` is writable the same way (Codex saves project trust there),
merged per leaf so hand-added MCP servers survive beside Nix's. Cua Driver gives Pi, Claude Code, and Codex computer use: its notarized
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
extensions (minus `pi-workflows`, whose tool collides with `omo.js`, and the command palette,
session tree, orchestrator and agent-forum client, which stay Pi-only), skills, and keybindings,
plus the `/unsupervised <task>` prompt template (`features/omo/prompts/`, adapted from
fersilva16: ultrawork, no questions, tested end to end, nothing pushed or committed except
a branch inside a sandbox, where only commits leave),
plus OmO-only packages (findings-cache, cloud-mode, ui-chrome, ui-prompt) auto-discovered from
`features/omo/extensions/<name>/` (any subdirectory
with a `package.json`; used for extensions that hook OmO internals or OmO-only features);
its writable `settings.json` gets the same baseline merge, including Pi's quiet startup,
condensed changelog, and resume-hint exit output, plus `tips = false` and Nix-owned model
defaults: Opus 5.5 at `high`, a picker and task chains using Opus 5.5, Sonnet 5.5,
Fable 5.1, GPT-6 Astra, and GPT-6 Sol. The picker also lists Refuseless GLM 5.3 Abliterated, a
custom `refuseless` provider in `models.nix` (OpenAI chat completions, `low`/`high`/`max`
thinking only, the API rejects other efforts). It reads `$REFUSELESS_API_KEY`, which
`secrets-env.nix` exports from `op://Nix/REFUSELESS_API_KEY`, so it works only in an `omo`
started from a shell that has the variable. Claude IDs use the authenticated
`anthropic-subscription` provider throughout startup, picker, task chains, and
image overrides; `anthropic` has no login and made new sessions pick ChatGPT
instead. OmO saves every model or thinking switch as the global default, so the
`omo` launcher restores Opus 5.5 at `high` before each new session (the default in
`settings.json` and Opus's per-model thinking memory in `state.json`, which outranks the
default); resumed sessions keep their own model. Only the orchestrator leader runs above `high`: subagent and category chains are capped there. `models.json` caps Opus 5.5's and Sonnet 5.5's planning
`contextWindow` at 300k (the account keeps the 1M window), so OmO auto-compacts them near
~210k and hard-stops near ~288k; the 1M window let them grow to ~770k uncompacted, and the
earlier fix (a 750k `compaction.modelOverrides` reserve) tripped the pre-prompt hard-limit
check on small sessions ("Nothing to compact"). The launcher defaults `CLAUDE_CODE_PROMPT_CACHE_TTL` to
`5m` (an experiment: 1h writes cost 2x yet missed after ~5 idle minutes; export `1h` to compare),
and `ENABLE_CLAUDEAI_MCP_SERVERS` to `false`: Claude Code otherwise loads the account's claude.ai
connectors into the SDK subprocess, whose schemas inflated some turns by ~566k cached tokens and
made a ~60k session read as 209% of the 300k window (export `true` to get them back).
Claude Haiku 4.5 is not used anywhere (catalogs, chains, orchestrator pool). Category tasks resolve from the fixed `omo.jsonc` category chains: the routine lanes (quick and writing at `low`, deep-low and unspecified-low at `medium`, unspecified-high and visual-engineering at `high`) are Sonnet 5.5-first so delegated work spares the Opus limit, the other lanes have their own chains, and `subagent_type` spawns use their agent chains. `~/.omo/omo.jsonc` is a read-only
store link holding cross-provider model chains, with OmO's config migrations pre-recorded.
It also turns OmO memory off on every host (`memory.enabled = false`): memory kept a repo per
checkout, so every Herdr worktree grew its own under `~/.omo/memory/agents`. Existing repos
there are left in place.
Memory guards (one monobloco session reached 20 GB): `models.json` caps stored images at
1568px / 750 KB for every catalog and chain model (keep its list in sync), because sessions
keep images as encoded and rebuild each request around all of them; `~/.senpi/agent/codemode.json`
(codemode reads `~/.senpi`, not `~/.omo`) runs JavaScript eval kernels as child processes
(`isolation.js = "process"`, on the nixpkgs `bun` the `omo` launcher puts on PATH) with a
4 GB recycle ceiling
and 30-minute idle parking; and the `omo-memwatch` launchd agent checks omo footprints every
30 s, writing a footprint/vmmap snapshot to `~/Library/Logs/omo-memwatch/` and notifying
above 4 GB (again at each 1.5x growth), then stopping the process above 12 GB. On Linux
(Mellon) memwatch is off: the `omo` launcher runs each session in a transient systemd user
scope (`MemoryHigh` 12G, `MemoryMax` 16G), and the generic glibc release binary runs
through nix-ld.

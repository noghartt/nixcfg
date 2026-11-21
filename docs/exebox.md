# exebox: exe.dev sandboxes

exe.dev sandboxes run alongside agentbox, opt-in only: `omo --cloud exe --sandbox[=name]` (or
`/cloud exe --sandbox`) works like `--cloud local --sandbox`, with `exebox` (Palantir and
Mithril, `features/exebox/`) in place of `agentbox`; cloud-mode picks the CLI by target
(`sandboxCli` in `ssh.ts`), so subagent sandboxes, handoff, and `publish` carry over. `exebox`
takes agentbox's command contract (`ensure --seed/--from/--net/--size`, `exec`, `env`,
`collect [--into]`, `keep`, `rm`, plus `ls`, `shell`, `reap`): each sandbox is one VM in the
account's exe.dev pool, named `<box>-<6 hex>` because VM names are global hostnames, with its
record (VM, home, seeded repo, last use, keep) in `$XDG_STATE_HOME/exebox/boxes/<box>/`. Seeding
and collecting move only committed history as git bundles piped over SSH (a `--from` child is
bundled out of its parent's VM, never `cp`'d, so uncommitted files stay put). Every connection
goes to `vm+<vm>@vm.exe.xyz` with exe.dev's host key pinned in Nix; short operations share a
ControlMaster under `~/.ssh/exebox/`, while a terminal (`-tt`) or `exec --own` gets its own
connection so killing the client stops the command. The key is the 1Password agent's:
exe.dev identifies an account by the first key offered, so `~/.ssh/exe_dev.pub` (optional,
not in Nix) pins which agent key that is. `ensure` installs git, ripgrep, and coreutils
`timeout` in a new VM. Sizes map to `--cpu/--memory` out of the pool (small 2/4 GB, medium
4/8 GB, large 8/16 GB; no flag uses exe.dev's default), and `--net` accepts only `open`, since
exe.dev cannot restrict egress (`none`/`dev` are refused, not ignored). `env` takes no catalog
variables: exe.dev has no secret store here, and GitHub reads belong to its GitHub
integration. `exec` exports `EXEBOX_URL` (`https://<vm>.exe.xyz`; ports 3000-9999 behind the
exe.dev login), which cloud-mode reads like `AGENTBOX_HOST`. exe.dev has no idle reaper, so the
hourly `exebox-reap` launchd agent removes VMs unused for 7 days (a live SSH session to the
VM counts as use, `exebox keep` exempts), after archiving branches, tags, and uncommitted work
(`refs/exebox/wip`) to `$XDG_STATE_HOME/exebox/archive/<box>/<stamp>/`, pruned after 30 days.
Not wired up yet: orchestrator workers (a leader under `--cloud exe` is refused at spawn) and aeval replay. The contract tests (`features/exebox/test.sh`) drive the real
script against a fake ssh at build time.

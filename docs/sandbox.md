# sbx: sandboxes

`sbx` (`home/noghartt/features/sandbox/`, every host) makes disposable machines for agents,
development and one-off jobs. It is a library and a CLI over a small provider interface;
exe.dev is the first provider, and a self-hosted runner on a Linux box is meant to be the
next. The package runs its TypeScript on Node 24 with native type stripping (no npm build)
and vendors `@exedev/sdk` from its npm tarball; the tests run in the build.

## Interface

`src/provider.ts` is the contract. A `SandboxProvider` creates, finds, lists, forks and
removes `Sandbox`es; a `Sandbox` runs POSIX sh scripts (`exec`, with streaming, buffered
stdin, cancellation and a timeout enforced on the sandbox), reads and writes files byte for
byte, uploads and downloads directories, pauses, resumes, gives URLs, is marked to keep, and
records use (`touch`: commands and file operations deliberately do not count, so the
reaper's own probes never keep a sandbox alive). `Capabilities` declares the optional parts
(fork, pause, sizing, egress policies, secret integrations, HTTPS URLs, interactive shell,
templates). Callers branch on capabilities, never on a provider's id; a kind that needs
something its provider lacks fails with an `UnsupportedError` when it is resolved. Two
optional hooks: `gitRemote(owner/repo)`, a credential-free URL sandboxes can clone and push
through, and `sweep`, which removes half-made sandboxes failed operations left behind.

Exit codes: a nonzero exit is a result; a command killed by signal N exits 128+N, a timed-out
one 124 (137 if it ignored SIGTERM for the 10-second grace). Stdin is uploaded before the
command starts, because exe.dev's API has no stdin: it suits files and prompts, not
interactive streams.

Seeding a checkout and pulling branches back are core (`src/core.ts`), built on `exec`,
`writeFile` and `readFile`, so every provider gets them. `src/index.ts` exports the library;
pi-durable is its first consumer (see Consumers).

`tests/contract.ts` is the suite every provider must pass. It runs against a local fake
(`src/testing.ts`, also the smallest example of a provider, exported so consumers' tests run on
it; it keeps the checkout metadata `create` gets, so seeding and pulls work on it), against the exe.dev
provider on a fake client, and, with `SBX_LIVE=1`, against exe.dev itself
(`tests/live.test.ts`, which creates and removes real VMs). `tests/sdk-client.test.ts` drives
the real SDK adapter against a stubbed `fetch` and pins the exact exe.dev command lines.

## Kinds

Kinds are VM kinds: network policy and size belong to the kind, not to the call. Nix writes
them to `~/.config/sbx/config.json`; a kind names its provider, egress (`all` or
`integrations`), cpu, memory and disk in GB, integrations, extra tags, a setup script, an
image and environment variables. The defaults:

- `dev` (default): internet, 2 vCPU / 4 GB, a setup script adding ripgrep, fd and jq;
  tagged `sbx-gh`, so it can push through the GitHub integrations.
- `agent`: no public internet (egress `integrations`), 2 vCPU / 4 GB, tagged `sbx-gh`. It
  reaches only exe.dev integrations: the account's `llm` (attached to every VM) and the
  GitHub repositories attached to `sbx-gh`. A restricted kind with a setup script can only
  start from a current template, since the script would have no internet.
- `job`: internet, 4 vCPU / 8 GB, no GitHub access, for expensive one-off compute through
  `sbx run`, which removes the VM afterwards unless `--keep`.

## exe.dev provider

Sandboxes are ordinary VMs in the Personal plan's shared pool (4 vCPU / 8 GB, up to 50 VMs,
200 GB disk shared by all of them); sizes are limits inside that pool, not reservations.
sbx never asks for standalone (per-second metered) VMs or pool placement; the SDK test
asserts no such flag is ever sent.

VM names are global hostnames, so a sandbox called `fix-login` is the VM `fix-login-<6 hex>`.
Every sbx VM carries the tags `sbx`, `sbx-name-<name>` and `sbx-kind-<kind>` (names and tags
are reduced to lowercase letters, digits and hyphens); VMs being set up also carry
`sbx-provisioning`. Only VMs tagged `sbx`, owned by the account (shared ones are skipped) and
finished are sandboxes. The repository, branch, seed commit and the day of last use live in
the VM's comment as compact JSON (at most 200 bytes), so every machine sees the same
sandboxes; the day stamp reads as that day's end, so the reaper never acts early. The only
local state is a precise last-used time per VM in `~/.local/state/sbx/last-used.json`,
updated under a lock.

Egress is set when the VM is created (`new --egress`, `cp --egress`), so a restricted VM never
has a window with internet. `sbx template build <kind>` creates a VM from the kind's setup
script, with internet because it only runs that trusted script, pauses it and tags it
`sbx-tpl`; `create` copies the template (with the kind's egress and size, then retags it)
when its fingerprint of setup, image and env matches. Otherwise it creates a fresh VM and
waits for the setup script, unless the kind is restricted (then it fails, asking for the
template). Templates are never listed, forked or reaped. URLs are `https://<vm>.exe.xyz`,
and ports 3000-9999 at `https://<vm>.exe.xyz:<port>`, private behind the exe.dev login.

Remote commands run through a wrapper (`src/shell.ts`), wrapped in `sh -c` so the login
shell does not matter, because closing an `ssh` request does not reliably stop the command:
the wrapper starts the command in its own session, records the process group under
`~/.sbx/run/`, and kills it if its connection dies (HUP, PIPE) or it is signalled. Any failed
`exec` (cancellation, a dropped stream, a throwing callback) also sends a second request that
kills the group. The kind's env is written to `~/.sbx/env`, which the wrapper sources, so
copies of templates get it too. Every removal is checked: a failed `rm` is followed by `ls`
and retried, and one that still fails names the VM to remove by hand.

## Auth

sbx holds a token scoped to the `sbx` tag: it sees and manages only VMs with that tag, and VMs
it creates get it. `sbx auth setup` prints the command to make it with the user's own exe.dev
key, `ssh exe.dev ssh-key generate-api-key --label=sbx-<host> --tag=sbx --exp=90d
--cmds=new,ls,cp,rm,ssh,tag,comment,pause,resume --json`, and reads the result from stdin
(piped, or pasted) into `~/.config/sbx/exe_token` (0600). `EXE_TOKEN` overrides it. As a
fallback, `sbx auth setup --key` makes `~/.config/sbx/exe_key` for `ssh exe.dev ssh-key add
--tag=sbx`, and sbx signs one-hour tokens from it locally. The user's own key stays in the
1Password agent.

The token cannot touch the user's other VMs, integrations, keys or billing. It can still
create and delete VMs tagged `sbx`, and run anything on them, so a leaked token can fill the
pool, delete sandboxes, or create metered VMs (the server does not let a token's `cmds` forbid
`--standalone`); keep it at 90 days and revoke it with `ssh exe.dev ssh-key list` and `remove`.

Integrations are account grants, so sbx prints them for the user to run once with their own
key, attached by tag rather than per VM: `sbx auth setup` and `sbx integrations` print
`integrations attach <name> tag:sbx-kind-<kind>` for kinds that list integrations, and
`sbx github add owner/repo [--readonly]` prints `integrations add github
--name=gh-<owner>-<repo>-<hash> --repository=owner/repo --attach=tag:sbx-gh` (link the GitHub
account once on exe.dev's Integrations page).

## Git

Sandboxes never hold GitHub tokens. `create --repo <path|owner/repo> [--branch b]` resolves
the branch to an exact commit (the local branch, or origin's when only origin has it; a
missing branch is an error) and warns about uncommitted changes, which stay behind. If the
provider offers a git remote and the sandbox can read it, the checkout is cloned from there,
`origin` stays there so the agent can push, and commits origin lacks follow as a thin `git
bundle`; if that bundle's base is gone from GitHub (a force-push), the whole branch is sent
instead. Without the remote (or for a repository not on GitHub) the whole branch goes as a
bundle, and `origin` points at the integration URL so pushing works once it exists. Either
way the checkout ends at the exact commit, or seeding fails and the sandbox is removed.
`sbx pull <name> [branch...]` fetches the sandbox's branches as `sbx/<name>/<branch>`,
bundling only commits after the seed commit when the local repository has it.

## Reaper

`sbx reap [--days 7]` removes sandboxes unused for that many days (last use, else creation);
templates and sandboxes marked with `sbx keep <name>` (tag `sbx-keep`) are exempt, and so is
any sandbox with a wrapped command still running or a login session. Before removing a
sandbox with a checkout it archives all its branches as a bundle to
`~/.local/state/sbx/archive/<name>/<stamp>/` (a failed archive keeps the sandbox); archives
older than 30 days are deleted. It also sweeps VMs left half-made for over an hour (still
`sbx-provisioning`, or a copy that never got its own tags). It runs hourly:
`launchd.agents.sbx-reap` on Darwin, a systemd user timer on Linux, both with
`--if-configured` so machines without credentials do nothing. `sbx run` cleans up on Ctrl-C,
SIGTERM, SIGHUP and a closed stdout; a second signal exits at once and names the VM to remove.

## Adding a provider

Implement `SandboxProvider` in `src/providers/<name>.ts` with honest capabilities, register its
factory in `src/builtin.ts`, add a provider entry and kinds for it in `default.nix`, and run
`tests/contract.ts` against it (a fake of its backend for the build, a live suite behind an
environment variable). Keep metadata on the backend rather than locally, make `exec`
cancellation stop the remote process, and offer `gitRemote` if the backend has credential-free
GitHub access.

## Consumers

- **pi-durable** (`docs/pi-durable.md`, Sandboxes) imports the library as `#sbx/*` (its
  `package.nix` links this package's `lib/sbx`) and reads the same `config.json` and kinds. It
  implements Durable's `ExecutionEnv` on `Sandbox.exec`/`readFile`/`writeFile`, so its coding tools
  run in a sandbox; seeds sandbox-isolated subagents and session sandboxes with `createSandbox` and
  brings their work back with `pullBranches`; and runs `sandbox_run` like `sbx run`. It uses the
  provider interface and capabilities only (`httpsUrl` decides whether its prompt offers port
  URLs), so a new provider works there unchanged. Its tests run on `src/testing.ts`. Names it
  makes start with `pd-` (session hash and key), so a rerun after a crash finds its sandbox;
  it records use with `touch` at most hourly while a conversation works in one.

## Development

`ln -s <unpacked @exedev/sdk> home/noghartt/features/sandbox/node_modules/@exedev/sdk` (ignored
by git), then `node --test tests/*.test.ts` in the feature directory runs the same tests as the
build.

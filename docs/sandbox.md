# sbx: sandboxes

`sbx` (`home/noghartt/features/sandbox/`, every host) makes disposable machines for agents,
development and one-off jobs. It is a library and a CLI over a small provider interface;
exe.dev is the first provider, and a self-hosted runner on a Linux box is meant to be the
next. The package runs its TypeScript on Node 24 with native type stripping (no npm build)
and vendors `@exedev/sdk` from its npm tarball; the tests run in the build.

## Interface

`src/provider.ts` is the contract. A `SandboxProvider` creates, finds, lists, forks and
removes `Sandbox`es; a `Sandbox` runs shell scripts (`exec`, with streaming, cancellation and
a timeout enforced on the sandbox), reads and writes files byte for byte, uploads and
downloads directories, pauses, resumes, gives URLs and is marked to keep. `Capabilities`
declares the optional parts (fork, pause, sizing, egress policies, secret integrations,
HTTPS URLs, interactive shell, templates). Callers branch on capabilities, never on a
provider's id; a kind that needs something its provider lacks fails with an
`UnsupportedError` when it is resolved. `src/index.ts` exports the library, so pi-durable can
later run subagents or a remote execution environment on `exec`/`readFile`/`writeFile`.

`tests/contract.ts` is the suite every provider must pass. It runs against a local fake
(`tests/fake-provider.ts`, also the smallest example of a provider), against the exe.dev
provider on a fake client, and, with `SBX_LIVE=1`, against exe.dev itself
(`tests/live.test.ts`, which creates and removes real VMs).

## Kinds

Kinds are VM kinds: network policy and size belong to the kind, not to the call. Nix writes
them to `~/.config/sbx/config.json`; a kind names its provider, egress (`all` or
`integrations`), cpu, memory and disk in GB, integrations to attach, extra tags, a setup
script, an image and environment variables. The defaults:

- `dev` (default): internet, 2 vCPU / 4 GB, a setup script adding ripgrep, fd and jq.
- `agent`: no public internet (egress `integrations`), 2 vCPU / 4 GB. It reaches only exe.dev
  integrations: the account's `llm` (attached to every VM) and the GitHub repositories added
  with `sbx github add` (attached to tag `sbx`). It has no setup script because one could not
  download anything; extra tooling goes into its template.
- `job`: internet, 4 vCPU / 8 GB, for expensive one-off compute through `sbx run`, which
  removes the VM afterwards unless `--keep`.

## exe.dev provider

Sandboxes are ordinary VMs in the Personal plan's shared pool (4 vCPU / 8 GB, up to 50 VMs,
200 GB disk shared by all of them); sizes are limits inside that pool, not reservations.
sbx never asks for standalone (per-second metered) VMs: usage is measured on the plan first.

VM names are global hostnames, so a sandbox called `fix-login` is the VM `fix-login-<6 hex>`.
Every sbx VM carries the tags `sbx`, `sbx-name-<name>` and `sbx-kind-<kind>` (names and tags
are reduced to lowercase letters, digits and hyphens), and only VMs tagged `sbx` are listed.
The repository, branch and the day of last use live in the VM's comment as compact JSON (at
most 200 bytes), so every machine sees the same sandboxes; the only local state is a precise
last-used time per VM in `~/.local/state/sbx/last-used.json`.

Egress is set when the VM is created (`new --egress`, `cp --egress`), so a restricted VM never
has a window with internet. `sbx template build <kind>` creates a VM from the kind's setup
script, with internet because it only runs that trusted script, pauses it and tags it
`sbx-tpl`; `create` copies the template (with the kind's egress, size, tags and
integrations) when its fingerprint of setup, image and env matches, else creates a fresh VM
and waits for the setup script. A failed copy falls back to a fresh VM. Templates are never
listed, forked or reaped. URLs are `https://<vm>.exe.xyz`, and ports 3000-9999 at
`https://<vm>.exe.xyz:<port>`, private behind the exe.dev login.

Remote commands run through a wrapper (`src/shell.ts`) because closing an `ssh` request does
not reliably stop the command: it starts the command in its own session, records the process
group under `~/.sbx/run/`, and cancelling sends a second request that kills the group.
Timeouts run on the VM with `timeout(1)` and exit 124. The kind's env is written to
`~/.sbx/env`, which the wrapper sources, so copies of templates get it too.

## Auth

sbx signs one-hour tokens locally (`signToken`) with a dedicated per-machine key,
`~/.config/sbx/exe_key` (ed25519, no passphrase, 0600), limited to the commands sbx runs. The
user's own exe.dev key stays in the 1Password agent and is never used. `sbx auth setup`
creates the key and prints the one manual step, `ssh exe.dev ssh-key add <
~/.config/sbx/exe_key.pub`; removing that key on exe.dev revokes every token it signed.
`EXE_TOKEN` overrides the key.

## Git

Sandboxes never hold GitHub tokens. `sbx github add owner/repo [--readonly]` creates the exe.dev
GitHub integration `gh-owner-repo` attached to tag `sbx`; the GitHub account must be linked
once on exe.dev's Integrations page. `create --repo <path|owner/repo> [--branch b]` checks
whether the VM can read the repository through `https://github.int.exe.xyz/owner/repo.git`;
if so it clones from there and leaves `origin` there, so the agent can push, and ships local
commits GitHub lacks as a thin `git bundle` fetched on top. Without the integration (or for a
repository not on GitHub) the whole branch goes as a bundle, and `origin` still points at the
integration URL so pushing works once it exists. `sbx pull <name> [branch...]` bundles the
sandbox's branches and fetches them into the local checkout as `sbx/<name>/<branch>`.

## Reaper

`sbx reap [--days 7]` removes sandboxes unused for that many days (last use, else creation);
templates and sandboxes marked with `sbx keep <name>` (tag `sbx-keep`) are exempt. It runs
hourly: `launchd.agents.sbx-reap` on Darwin, a systemd user timer on Linux, both with
`--if-configured` so machines without the key do nothing.

## Adding a provider

Implement `SandboxProvider` in `src/providers/<name>.ts` with honest capabilities, register its
factory in `src/builtin.ts`, add a provider entry and kinds for it in
`default.nix`, and run `tests/contract.ts` against it (a fake of its backend for the build, a
live suite behind an environment variable). Keep metadata on the backend rather than locally,
and make `exec` cancellation stop the remote process.

## Development

`ln -s <unpacked @exedev/sdk> home/noghartt/features/sandbox/node_modules/@exedev/sdk` (ignored
by git), then `node --test tests/*.test.ts` in the feature directory runs the same tests as the
build.

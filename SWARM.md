# Swarm mode

Agent swarms led from an OmO session. Code: `home/noghartt/features/swarm/` (imported on
Palantir and Mellon). Status: **implemented**. The local backend has been exercised end to end
with real OmO members. The `sbx` backend (Palantir) has not run yet (see
[Untested on sbx](#untested-on-sbx)), and the `agentbox` backend (Mellon) has only run against
stub binaries (see [Untested on agentbox](#untested-on-agentbox)).

## Goal

One OmO session leads a swarm of peer agents, from a handful up to 30. Members work in
isolated sandboxes (`sbx` microVMs on Palantir, `agentbox` nspawn containers on Mellon) and coordinate through a shared board: they post
discoveries, decisions, and questions, claim areas, ask peers, request permissions, and
publish skills they built for each other. The leader holds the master context and integrates
the result. A swarm runs one of two patterns, and the leader may combine them:

- **parallel**: members own different parts of the goal and share knowledge while they work.
  The leader integrates their branches.
- **evolve**: members of a generation attack the same goal with different approaches. Each
  finished member gets a fitness score (Jev's per-criterion judgment, and the fitness command
  when one exists). The leader picks survivors, distills lessons, and starts the next
  generation. Children start from a survivor's branch and receive the parents' reports, the
  lessons, and the published skills. This repeats until the result is good enough or
  `maxGenerations` runs out.

## Decisions (2026-10-07)

| Topic | Decision |
| --- | --- |
| Isolation | `sbx` local sandboxes on Palantir. On Mellon (sbx does not support NixOS) each member gets its own `agentbox` sandbox, and `agentbox` is the default whenever its CLI is on PATH (2026-10-13). `--local` runs members on the host for development. |
| Credentials | Subscription OAuth by default. API billing is opt-in per member, and the user confirms it in the leader session every time. |
| Scale | 20-30 concurrent members, with a queue beyond the memory budget. |
| Leader | The user's OmO session, via `/leader`. Members keep running when it closes; `/leader attach <id>` or the panel re-binds. |
| Approvals | In-scope actions are auto-approved. Destructive actions outside the member's worktree (except `/tmp`) are held for the user. |
| Gating | Jev picks member models from the pool and gates results. Without `TYPESAFE_API_KEY` results are ungated. |
| Output | The leader decides per goal: one PR, a stack of PRs, or a report. |
| Models | Aligned with the orchestrator (2026-10-13). Leader: Opus 5.5 `xhigh`, the first of `anthropic-subscription/…`, `anthropic/…` with credentials. Members come from a pool of `sonnet` (tier 1, `medium`; GPT-5.6 Terra fallback), `opus` (tier 2, `high`; GPT-6 Sol fallback), and `fable` and `gpt-astra` (tier 3, `high`), picked by Jev; the default is `sonnet`. Each entry lists models in preference order and the member runs the first it has credentials for. No Haiku, GPT-5.6 Sol, or GPT-5.6 Luna. |

## Use

```console
/leader [--pattern parallel|evolve] [--local] [--net PROFILE] [--size CLASS] [--criteria TEXT]... [--fitness CMD] <goal>
/leader attach <id> | off | status
/swarms                        panel: swarms for this repo, members, board, attach
swarm ls | status ID | board ID [--follow] | attach ID MEMBER | send ID TO TEXT
swarm approve|deny ID PERMISSION | stop ID [MEMBER...] | resume ID | rm ID
```

`/leader <goal>` starts the daemon, switches the session to the leader model, and adds the
leader tools: `swarm_configure`, `swarm_spawn`, `swarm_wait`, `swarm_status`, `swarm_send`,
`swarm_board`, `swarm_decide`, `swarm_evolve`, `swarm_collect`, `swarm_stop`, and
`swarm_restart`. `/leader off` restores the previous model and leaves the swarm running.

Members get `swarm_board`, `swarm_post`, `swarm_ask`, `swarm_wait`, `swarm_peers`,
`swarm_claim`/`swarm_release`, `swarm_permission`, `swarm_skill_publish`, `swarm_skills`,
`swarm_skill_fetch`, and `swarm_done`. Messages relayed into any session carry a `[swarm] `
prefix, which the system prompt vouches for. Messages addressed to a member reach it as a
prompt or a steer. Broadcasts (`*`) reach only members still working. Everything else waits
on the board, and member tool results say when there are unread posts. `swarm_done` refuses
while the worktree has uncommitted changes, so every result can be collected.

In the `/swarms` panel: `enter` attaches to a member's live session (a `--local` member's
Herdr tab is focused; a pod member opens in a new Herdr pane running `swarm attach`, or
the command to run outside Herdr), `m` messages it, `p` decides
its pending permission, `s` stops it, `b` shows the board, `l` makes this session the leader,
and `a` toggles between this repo's swarms and all of them. An `agentbox` member's OmO runs
on the host, so `enter` focuses its Herdr tab like a `--local` member's.

`swarm start --backend auto|agentbox|sbx|local` (default `auto`: `agentbox` where its CLI is on
PATH, else `sbx`). For `agentbox`, `--net PROFILE` and `--size small|medium|large` are passed to
`agentbox ensure` for every member (defaults `dev` and `small`, set in `config.json`).

## Architecture

```
leader: OmO session with /leader (Opus 5.5 xhigh) -- HTTP --+
                                                             v
swarmd (`swarm serve`, detached, one per swarm, 127.0.0.1:<port>)
  ~/.omo/swarms/<id>/  state.json  board.jsonl  cursors.json  skills/  daemon.json  daemon.log
  daemon.json keeps the board's port and token across restarts: members and pod policies hold them
  scheduler: pods under the memory budget, queue, liveness, Jev model pick and gating
  |
  +-- sbx:   pods `swarm-<id>-pN` = `sbx run --detached --clone --memory <podMemory> <kit> <repo>`
  |          each member: worktree /home/agent/swarm/<name> on swarm/<id>/<name>,
  |          tmux session <name> running `omo --no-extensions -e /opt/swarm/swarm/extension/index.ts`,
  |          board at http://host.docker.internal:<port> (per-pod `sbx policy allow network localhost:<port>`)
  +-- agentbox: sandbox `swarm-<id8>-<member>` per member (`agentbox ensure NAME --seed <repo>
  |          [--from <parent box>] --net dev --size small`), branch swarm/<id>/<member> inside it;
  |          the member's OmO runs on the HOST in a tab of the Herdr workspace `swarm <id>`
  |          with OMO_CLOUD=local:<repo> and OMO_CLOUD_SANDBOX=<box>, so cloud-mode aims its
  |          tools into the sandbox; board at http://127.0.0.1:<port> from the host process
  +-- local: worktrees under the run dir; Herdr workspace `swarm <id>`, one tab per member
             (labeled with its name) running the host `omo` from a mode-700 script under
             launch/, so the board token stays out of shell history; an exited member leaves
             its tab at the shell prompt, which is how liveness sees the exit
```

- **Lineage:** the start creates `swarm/<id>/base` at the leader's HEAD. `swarm_collect`
  fetches every pod's `swarm/<id>/*` branches into the host repo through the
  `sandbox-<pod>` remotes. Pods read the parents of later generations from the read-only
  host repo at `/run/sandbox/source`. The leader integrates on `swarm-integration/<id>`,
  outside the fetched namespace.
- **agentbox lineage:** a sandbox is seeded from the repo, and its member branch starts at the
  base commit (resolved on the host, so it does not depend on the seed carrying the base branch).
  A later generation's sandbox is seeded `--from` its first parent's sandbox, which holds the
  parent's branch, and starts on top of it. `swarm_collect` commits each sandbox's leftovers
  (`swarm: uncommitted work in <box>`) and runs `agentbox collect`, so the member branches land in
  the leader's repo as `sandbox/<box>/swarm/<id>/<member>` (that name is what `swarm_collect`
  lists). Only committed history crosses.
- **agentbox scaling and teardown:** one sandbox per member, so `podSize` does not apply. The
  size class (`small` 8g, `medium` 16g, `large` 32g) is the budget unit: live members are capped at
  floor(0.75 × host RAM / size memory), and members beyond it queue. Stopping a member
  (`swarm_stop`, an evolve step) closes its Herdr tab but keeps the sandbox, because the next
  generation seeds from it; `swarm rm` collects every branch and then runs `agentbox rm NAME --yes`
  on each. Idle expiry (12h stop, 7d remove, archived) only backstops a swarm nobody removes: it is
  not the plan, since an unattended `rm` after the branches are collected is deterministic and
  frees the disk now, while expiry would take days and keep archives for 30.
- **agentbox credentials and approvals:** none enter a sandbox: the OmO process, its models,
  and its auth stay on the host, and the sandbox only runs tool calls. Sandboxes follow
  `agentbox`'s own network policy (profile `dev` by default); the board needs no exception because
  the member process reaches it from the host. The out-of-scope approval classifier is skipped for
  a sandboxed member, as destructive-guard does, since the container is disposable and holds no
  credentials. Skills move in and out through `agentbox exec` (`swarm_skill_fetch` installs under
  the sandbox's `~/.swarm-skills`; files above about 90 KB are skipped). API-billing fallback is
  not available (the host's own logins are already in use).
- **Scaling:** pods hold `podSize` members (default 5), each pod limited to `podMemory`
  (default `3g`). The budget allows floor(0.75 × host RAM / podMemory) pods, which is 6 pods
  (30 members) on 24 GiB. Members beyond it queue. Tune both in `config.json` or with
  `--pod-size`/`--pod-memory` after measuring real usage.
- **Credentials:** pods get a per-member `auth.json` holding the host's OAuth access tokens,
  with a dummy refresh token and expiry stretched by 4 minutes. The leader session asks the
  registry for each provider's auth every minute, which runs OmO's own locked refresh, and
  swarmd pushes `auth.json` to every pod whenever it changes. Billing fallback
  (`swarm_restart` with `billing`, confirmed by the user) stores the host's
  `ANTHROPIC_API_KEY`/`OPENAI_API_KEY` as a per-pod `sbx secret set-custom` placeholder, so
  the real key stays behind the proxy.
- **Approvals:** the member extension classifies every `bash`, `write`, and `edit` call
  (`src/approval.ts`). Out-of-scope destructive calls become `out` permissions that block the
  call until the user decides, in a leader-session dialog, the panel, or `swarm approve|deny`.
  They are denied after 15 minutes. Explicit `swarm_permission` requests go to the leader
  model (`swarm_decide`). Known gap: the classifier does not follow `cd`, so relative paths
  resolve against the member's cwd.
- **Kit:** `features/swarm/kit/` is a v3 workload kit (Dockerfile + descriptor) built on
  `docker/sandbox-templates:shell`, adding tmux, ripgrep, fd, jq, the pinned
  `omo-linux-arm64` (same version as the host's OmO; bump both together), and this package.
  sbx builds it on first use.

## Untested on agentbox

The daemon and backend ran end to end only against stub `agentbox`, `herdr`, and `omo` binaries
(real git clones standing in for sandboxes): start, spawn, done with the dirty-tree refusal,
collect, an evolve child seeded `--from` its parent's sandbox, and `swarm rm`. After the switch,
check against the real thing:

1. `agentbox ensure` accepting `--net`/`--size` (contract C1, implemented by the sandboxes track) and
   the seed carrying the base commit; a member's first `agentbox exec` working non-interactively
   from the daemon (no TTY) and with the daemon outside the `agentbox` group's login session.
2. cloud-mode in the member's OmO reading OMO_CLOUD/OMO_CLOUD_SANDBOX, finding the already-created
   sandbox, and landing in the same directory as `SWARM_WORKTREE`.
3. `agentbox collect` naming branches `sandbox/<box>/<branch>` in the leader's repo (the
   `swarm_collect` listing and `hostBranch` assume it), and `--from` seeding a child with the
   parent's branch.
4. A sandbox idle-stopped while its member waits hours on the board: the next tool call must start
   it again (otherwise `swarm_restart`, which re-runs `ensure`).
5. The live-member cap against Mellon's real RAM, and what `small` (4 cores, 8G) does to test runs.

## Untested on sbx

`sbx` is installed by the Darwin config but was never signed in when this was written, so the
pod path has only been checked against `sbx --help` (v0.47.0) and the docs. Expect to debug
these on the first run:

1. The kit build: base image name, apt packages, and the network-policy allowlist.
2. `sbx cp` of the per-member `auth.json` plus the `chown` as root, and OmO accepting the
   copied OAuth token inside the VM (and re-reading the file when it sees expiry).
3. Members reaching the board through `host.docker.internal` after the policy rule.
4. Whether `sbx run --detached` keeps the pod up while only tmux sessions run in it.
5. The memory footprint per pod and member, which sets `podSize`/`podMemory`.

For a first run, `swarm start --backend sbx --goal "..."`, then spawn one member from
`/leader` and watch `~/.omo/swarms/<id>/daemon.log` and `swarm status <id>`.

## Setup (Mellon)

Nothing to install: `features/swarm` is imported by Mellon's entrypoint, the `swarm` CLI picks the
`agentbox` backend because `agentbox` is on PATH, and the leader session must be in Herdr
(members are Herdr tabs). The user running the leader needs the `agentbox` group; a long-lived
Herdr server that predates joining it goes through `sg agentbox`. `swarm start --backend local`
still works without sandboxes.

## Setup (Palantir)

After `darwin-rebuild switch` installs `sbx` and the `swarm` CLI:

```console
$ sbx login                 # Docker OAuth in the browser; required before any sandbox runs
$ sbx policy init balanced  # one-time global network policy; pods fail to start without it
$ sbx ls
```

The swarm does not run `sbx policy init` itself: the global policy applies to every sandbox on
the host, so the posture (`allow-all`, `balanced`, `deny-all`) is the user's choice. The kit's
per-sandbox allowlist and the board rule apply on top of it.

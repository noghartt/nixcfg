# Swarm mode

Agent swarms led from an OmO session. Code: `home/noghartt/features/swarm/` (imported on
Palantir). Status: **implemented**. The local backend has been exercised end to end with
real OmO members, and the `sbx` backend has not run yet (see [Untested on sbx](#untested-on-sbx)).

## Goal

One OmO session leads a swarm of peer agents, from a handful up to 30. Members work in
Docker Sandboxes (`sbx` microVMs) and coordinate through a shared board: they post
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
| Isolation | `sbx` local sandboxes on Palantir. Mellon (sbx does not support NixOS) comes later. `--local` runs members on the host for development. |
| Credentials | Subscription OAuth by default. API billing is opt-in per member, and the user confirms it in the leader session every time. |
| Scale | 20-30 concurrent members, with a queue beyond the memory budget. |
| Leader | The user's OmO session, via `/leader`. Members keep running when it closes; `/leader attach <id>` or the panel re-binds. |
| Approvals | In-scope actions are auto-approved. Destructive actions outside the member's worktree (except `/tmp`) are held for the user. |
| Gating | Jev picks member models from the pool and gates results. Without `TYPESAFE_API_KEY` results are ungated. |
| Output | The leader decides per goal: one PR, a stack of PRs, or a report. |
| Models | Leader: Opus 5.5 `xhigh`. Members: Sonnet 5.5 `high`/`medium` (Jev's choice), plus ChatGPT `terra`/`sol`. Haiku 5.5 and `gpt-5.6-luna` are opt-in pool keys only. |

## Use

```console
/leader [--pattern parallel|evolve] [--local] [--criteria TEXT]... [--fitness CMD] <goal>
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
and `a` toggles between this repo's swarms and all of them.

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

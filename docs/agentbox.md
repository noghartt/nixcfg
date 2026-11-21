# Agentbox: Mellon agent sandboxes

Mellon's agent sandboxes (`hosts/mellon/sandboxes/`) are systemd-nspawn containers, one per
sandbox, each booted from a writable btrfs snapshot of a Nix-built base image on the `/agent`
volume (`/agent/base/<hash>` read-only, `/agent/sandboxes/<name>`). Isolation: private user
namespace (`--private-users=pick`, idmapped), own veth (`ve-ab-*`) on a fixed /28 of
`10.231.0.0/16` (host `.1`, sandbox `.2`; per-sandbox runtime networkd files with DHCP server
and masquerade, NetworkManager ignores those links), no host bind mounts, its own Nix store
and daemon, and per-sandbox slice limits under `agentbox.slice` by size class (`agentbox size
NAME small|medium|large`, `ensure --size`; small 4 cores/8G, medium 8/16G (default), large
16/32G: `MemoryMax`, `CPUQuota`, and an `AllowedCPUs` window of that many cores, so `nproc` and
test runners inside size their worker pools to the sandbox; applied live; the whole slice has
half the default CPU weight). The policy is in the iptables
mangle table, which runs before every filter chain, so tailscaled's and Docker's FORWARD
accepts cannot bypass it: new connections from a sandbox follow its net profile
(`hosts/mellon/sandboxes/net-profiles.nix`, `agentbox net NAME [PROFILE]`, `ensure --net`,
applied live: the sandbox's /28 moves between `agentbox-src-<profile>` ipsets, strict
reverse-path filtering on the veths keeps sources honest, and narrowing deletes its tracked
connections): `dev` (default for new sandboxes) reaches only the addresses its allowlisted
domains resolve to through the sandbox resolver (a second dnsmasq on the veths,
`agentbox-dns.service`, filling `agentbox-dst-<profile>` via `ipset=`; DNS sent elsewhere is
redirected to it), `none` nothing (not even DNS), `open` any public IPv4; sandboxes created
before profiles have no record and count as `open` (`agentbox-net.service` restores set
membership after the firewall starts); allowlists are IP-based and leak through CDNs. DHCP
hands every sandbox the resolver at its veth's host address; new connections into a sandbox come only from `tailscale0`, and there is no IPv6.
Tailnet devices reach sandboxes directly: Mellon advertises `10.231.0.0/16` as a subnet route
and dnsmasq (tailnet address only, hostsdir `/run/agentbox/dns`) answers
`<name>.sandbox.internal`; the route approval and the split-DNS nameserver live in the
Tailscale admin console. Servers inside must listen on 0.0.0.0.
`agentbox` (group `agentbox`) is the CLI: `ls`, `ensure NAME --seed PATH` (create, cloning
PATH's repo from a git bundle, or with `--from BOX` from BOX's clone of it, or start), `exec`,
`shell`, `collect` (branches back into the host repo, or `--into BOX`'s clone, as
`sandbox/NAME/*`), `keep`, `net`, `size`, `start`/`stop`, `recreate` (onto the current image,
restoring its repos, uncommitted work, env, keep, net, size, and address from an archive),
`rm`; `agentbox ls` ends with net and size columns. It reaches `agentbox-root`, the only
privileged entry point, through `agentbox-rootd`: a socket-activated root service on
`/run/agentbox/root.sock` (world-connectable, `Accept=yes`, one process per call, so concurrent
calls are independent and a rebuild never cuts running ones) that identifies the caller by
`SO_PEERCRED` and lets it in when the group database lists its user in `agentbox` (so a
process that predates joining the group, like a long-lived Herdr server, works); the client
passes its stdin/stdout/stderr over the socket, an `exec` on a terminal gets a fresh pty as
its controlling terminal (job control, signals, window size, relayed by the client), no caller
environment crosses except a validated `TERM`, the exit status comes back, and a client that
dies takes its command with it (the exec's scope is killed); `exec` enters the container as its uid-1000
`agent` user inside a scope in the sandbox's slice. Only committed history crosses in either
direction, always as bundles. `agentbox-base.service` lays down a new base when the image
changes; existing sandboxes keep the image they were created from (`agentbox recreate` to
upgrade).
Environment variables reach a sandbox only by opt-in: `sandboxes/env-catalog.nix` declares
what may be given (`reference` = 1Password, resolved by opnix's NixOS module at boot into
root-only files under `/var/lib/opnix/secrets/agentbox-env/`, token in `/etc/opnix-token`;
`value` = non-secret literal), `agentbox env NAME KEY...|--none` picks per sandbox, and
`agentbox-root exec` exports them inside from an unlinked file on fd 3, never on a command
line. `GH_TOKEN` is a read-only GitHub token for the image's `gh` (API reads only: Git always
goes over SSH, never HTTPS, and sandboxes hold no SSH keys); writes go through cloud mode's
`publish`. Anything given
to a sandbox can leave it, so catalog secrets stay narrowly scoped.
Sandboxes expire from disuse (thresholds in `sandboxes/default.nix`): the hourly
`agentbox-reap.timer` stops one idle for 12h and removes one idle for 7d, after bundling
every repo's branches, tags, and uncommitted work (a commit on HEAD at `refs/agentbox/wip`,
built in a scratch index; git run inside the sandbox) into `/agent/archive/<name>/<stamp>/`
with a `repos.tsv` manifest (bundle, path, origin) and the agent's git `identity`,
group-readable and pruned after 30d. Idle time counts from
the last `create`/`start`/`exec`, and a live `exec` scope in the sandbox's slice (an open
shell or cloud-mode bash session) counts as use; if any repo with refs fails to bundle, the
sandbox is kept. `agentbox keep NAME 30d|forever|off` exempts one; when a keep lapses its
idle clock restarts. Removal is what frees a superseded base's extents, since sandboxes
snapshotted from it still share them.

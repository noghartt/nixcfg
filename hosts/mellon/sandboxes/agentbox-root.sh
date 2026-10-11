# agentbox-root: the only privileged entry point to agent sandboxes, reached
# through one sudo rule (default.nix). It validates every argument and never
# reads or runs content from inside a sandbox: `exec` only enters the
# container's namespaces as its unprivileged agent user.
# Set by Nix above this text: IMAGE (store path holding system + init), LIMITS.

ROOT=/agent
BASES=$ROOT/base
BOXES=$ROOT/sandboxes
NET=$ROOT/net
NETWORKD=/run/systemd/network
DNS_DIR=/run/agentbox/dns
DOMAIN=sandbox.internal

die() {
  printf 'agentbox: %s\n' "$*" >&2
  exit 1
}

valid() {
  [[ ${1-} =~ ^[a-z0-9][a-z0-9-]{0,30}$ ]] || die "invalid sandbox name '${1-}' (a-z, 0-9 and -, at most 31 characters)"
}

# Names keep their dashes, which systemd reads as slice nesting; escaping makes
# each sandbox a direct child of agentbox.slice.
escaped() { systemd-escape -- "$1"; }
unit() { printf 'agentbox@%s.service' "$(escaped "$1")"; }
slice() { printf 'agentbox-%s.slice' "$(escaped "$1")"; }

state() {
  if [[ ! -d $BOXES/$1 ]]; then
    echo absent
  elif systemctl is-active --quiet "$(unit "$1")"; then
    echo running
  else
    echo stopped
  fi
}

# Sandbox n owns the n-th /28 of 10.231.0.0/16, which the tailnet routes here:
# .1 is this host and .2, the DHCP pool's only address, is the sandbox, so
# its DNS name is known before it boots.
index() {
  local i used lock
  if [[ -f $NET/$1 ]]; then
    cat "$NET/$1"
    return
  fi
  install -d -m 0700 "$NET"
  exec {lock}>"$NET/.lock"
  flock "$lock"
  used=$(cat "$NET"/* 2>/dev/null || true)
  for ((i = 1; i < 4096; i++)); do
    if ! grep -qx "$i" <<<"$used"; then
      echo "$i" >"$NET/$1"
      exec {lock}>&-
      echo "$i"
      return
    fi
  done
  die "no free sandbox subnet"
}

address() {
  local base
  base=$(($(index "$1") * 16))
  echo "10.231.$((base / 256)).$((base % 256 + $2))"
}

# nspawn shortens long veth names but keeps the full one as an altname, which
# networkd's Name= also matches. Leases are not persisted: the pool is one
# address, and a recreated sandbox asks with a new client id.
network() {
  mkdir -p "$NETWORKD" "$DNS_DIR"
  cat >"$NETWORKD/40-agentbox-$1.network" <<EOF
[Match]
Name=ve-ab-$1

[Link]
RequiredForOnline=no

[Network]
Address=$(address "$1" 1)/28
DHCPServer=yes
IPMasquerade=ipv4
LinkLocalAddressing=no
IPv6AcceptRA=no

[DHCPServer]
PoolOffset=2
PoolSize=1
PersistLeases=no
EmitDNS=yes
DNS=1.1.1.1 9.9.9.9
EOF
  networkctl reload
  printf '%s %s.%s\n' "$(address "$1" 2)" "$1" "$DOMAIN" >"$DNS_DIR/$1"
}

start() {
  network "$1"
  systemctl set-property --runtime "$(slice "$1")" "${LIMITS[@]}"
  systemctl start "$(unit "$1")"
}

# Copies the image closure into a fresh read-only base subvolume; sandboxes are
# writable snapshots of it. Older bases go: existing sandboxes own their data.
base() {
  local name dir tmp old
  name=$(basename "$IMAGE")
  # The suffix versions the layout below; bump it when that changes, since an
  # existing base is never rewritten.
  name=${name%%-*}-2
  dir=$BASES/$name
  install -d -m 0700 "$BASES" "$BOXES"
  if [[ ! -e $dir ]]; then
    tmp=$BASES/.tmp-$name
    if [[ -e $tmp ]]; then btrfs subvolume delete "$tmp" >/dev/null; fi
    btrfs subvolume create "$tmp" >/dev/null
    nix --extra-experimental-features nix-command copy --no-check-sigs --to "local?root=$tmp" "$IMAGE"
    # nspawn refuses a tree without /usr.
    mkdir -p "$tmp"/{agentbox,etc,home,root,tmp,usr/bin,var/lib} "$tmp"/nix/var/nix/{profiles,gcroots}
    chmod 0700 "$tmp/root"
    chmod 1777 "$tmp/tmp"
    touch "$tmp/etc/os-release" "$tmp/etc/machine-id"
    # Stable paths inside the sandbox, so a sandbox keeps booting its own image
    # after the host moves on to a newer one.
    ln -s "$IMAGE/init" "$tmp/agentbox/init"
    ln -s "$(readlink "$IMAGE/system")" "$tmp/nix/var/nix/profiles/system-1-link"
    ln -s system-1-link "$tmp/nix/var/nix/profiles/system"
    ln -s /nix/var/nix/profiles "$tmp/nix/var/nix/gcroots/profiles"
    mv "$tmp" "$dir"
    btrfs property set -ts "$dir" ro true
  fi
  ln -sfn "$name" "$BASES/current"
  for old in "$BASES"/*; do
    if [[ $old != "$dir" && ! -L $old && -d $old ]]; then btrfs subvolume delete "$old" >/dev/null; fi
  done
}

cmd=${1-}
shift || true
case $cmd in
base)
  base
  ;;
ls)
  for box in "$BOXES"/*; do
    [[ -d $box ]] || continue
    name=${box##*/}
    where=-
    if [[ -f $NET/$name ]]; then where="$name.$DOMAIN ($(address "$name" 2))"; fi
    printf '%s\t%s\t%s\n' "$name" "$(state "$name")" "$where"
  done
  ;;
state)
  valid "${1-}"
  state "$1"
  ;;
create)
  valid "${1-}"
  [[ -L $BASES/current ]] || die "no base image yet; check agentbox-base.service"
  [[ ! -e $BOXES/$1 ]] || die "sandbox $1 already exists"
  btrfs subvolume snapshot "$(readlink -f "$BASES/current")" "$BOXES/$1" >/dev/null
  start "$1"
  ;;
start)
  valid "${1-}"
  [[ -d $BOXES/$1 ]] || die "no sandbox named $1"
  start "$1"
  ;;
stop)
  valid "${1-}"
  systemctl stop "$(unit "$1")"
  ;;
rm)
  valid "${1-}"
  [[ -d $BOXES/$1 ]] || die "no sandbox named $1"
  systemctl stop "$(unit "$1")"
  btrfs subvolume delete --recursive "$BOXES/$1" >/dev/null
  rm -f "$NET/$1" "$NETWORKD/40-agentbox-$1.network" "$DNS_DIR/$1"
  networkctl reload
  # dnsmasq notices new hostsdir files by itself, but forgets removed ones
  # only when it rereads them.
  systemctl kill --signal=HUP dnsmasq.service 2>/dev/null || true
  ;;
exec)
  valid "${1-}"
  name=$1
  shift
  [[ ${1-} == -- ]] && shift
  (($#)) || die "usage: agentbox-root exec NAME -- COMMAND..."
  leader=$(machinectl show "ab-$name" --property=Leader --value 2>/dev/null) || die "sandbox $name is not running (agentbox start $name)"
  # The scope puts the command under the sandbox's slice, so it counts against
  # the same memory, CPU and task limits as the container itself.
  exec systemd-run --quiet --scope --collect --slice="$(slice "$name")" -- \
    nsenter --target="$leader" --all --root --wdns=/home/agent --setuid=1000 --setgid=100 -- \
    /run/current-system/sw/bin/env -i \
    HOME=/home/agent USER=agent LOGNAME=agent LANG=C.UTF-8 TERM="${TERM:-dumb}" \
    AGENTBOX_HOST="$name.$DOMAIN" \
    SHELL=/run/current-system/sw/bin/bash \
    PATH=/run/wrappers/bin:/home/agent/.nix-profile/bin:/etc/profiles/per-user/agent/bin:/nix/var/nix/profiles/default/bin:/run/current-system/sw/bin \
    "$@"
  ;;
*)
  die "usage: agentbox-root base|ls|state|create|start|stop|rm|exec ..."
  ;;
esac

# agentbox-root: the only privileged entry point to agent sandboxes, run by
# agentbox-rootd for members of the agentbox group (default.nix). It validates
# every argument and never reads or runs content from inside a sandbox: `exec`
# only enters the container's namespaces as its unprivileged agent user.
# Set by Nix above this text: IMAGE (store path holding system + init), LIMITS
# (shared by every size), the size classes: SIZE_NAMES, SIZE_CPUS (the width
# of a sandbox's CPU window), SIZE_MEMORY, DEFAULT_SIZE; the net profiles:
# NET_NAMES, NET_OPEN (any public IPv4), NET_SET (each profile's source set),
# DEFAULT_NET, make_sets (creates the kernel sets); the expiry policy as
# durations (12h, 7d, ...): STOP_AFTER, EXPIRE_AFTER, ARCHIVE_TTL, and the env
# catalog: ENV_NAMES, ENV_VALUES (literals), ENV_DIR (opnix-resolved secrets,
# one root-only file per name).

ROOT=/agent
BASES=$ROOT/base
BOXES=$ROOT/sandboxes
NET=$ROOT/net
META=$ROOT/meta
ARCHIVE=$ROOT/archive
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

member() {
  local want=$1 known
  shift
  for known; do [[ $known == "$want" ]] && return 0; done
  return 1
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
DNS=$(address "$1" 1)
EOF
  networkctl reload
  printf '%s %s.%s\n' "$(address "$1" 2)" "$1" "$DOMAIN" >"$DNS_DIR/$1"
}

# Net profiles. A sandbox's /28 sits in its profile's source set, which the
# firewall matches (with a strict reverse-path check, so a sandbox cannot
# borrow another's addresses). Sandboxes created before profiles existed have
# none recorded and keep today's behaviour, open; a recorded profile that no
# longer exists counts as none.
profile() {
  local p=open
  if [[ -f $META/$1.net ]]; then p=$(<"$META/$1.net"); fi
  if member "$p" "${NET_NAMES[@]}"; then echo "$p"; else echo none; fi
}

subnet() { echo "$(address "$1" 0)/28"; }

admit() {
  local net set want
  [[ -f $NET/$1 ]] || return 0
  make_sets
  net=$(subnet "$1")
  want=${NET_SET[$(profile "$1")]}
  for set in "${NET_SET[@]}"; do
    if [[ $set != "$want" ]]; then ipset -exist del "$set" "$net"; fi
  done
  ipset -exist add "$want" "$net"
}

release() {
  local net set
  [[ -f $NET/$1 ]] || return 0
  make_sets
  net=$(subnet "$1")
  for set in "${NET_SET[@]}"; do ipset -exist del "$set" "$net"; done
}

# Only new connections are checked, so a narrower profile also drops the
# sandbox's tracked ones; their next packet is then new, and refused.
forget() {
  conntrack -D -f ipv4 -s "$(address "$1" 0)" --mask-src 255.255.255.240 >/dev/null 2>&1 || true
}

size_of() {
  local s=$DEFAULT_SIZE
  if [[ -f $META/$1.size ]]; then s=$(<"$META/$1.size"); fi
  if member "$s" "${SIZE_NAMES[@]}"; then echo "$s"; else echo "$DEFAULT_SIZE"; fi
}

# A window of as many cores as the size class gets, picked by subnet index so sandboxes
# spread over the host. A quota alone leaves nproc and os.availableParallelism() at the
# host's count, so test runners inside start a worker per host core and run out of the
# sandbox's memory.
cpus() {
  local width=$2 total windows start
  total=$(nproc --all)
  if ((width >= total)); then
    echo "0-$((total - 1))"
    return
  fi
  windows=$((total / width))
  start=$((($(index "$1") % windows) * width))
  echo "$start-$((start + width - 1))"
}

# Applies to a running sandbox at once: cpuset changes reach its processes'
# affinity, so nproc inside follows.
limit() {
  local size cores
  size=$(size_of "$1")
  cores=${SIZE_CPUS[$size]}
  systemctl set-property --runtime "$(slice "$1")" "${LIMITS[@]}" \
    "MemoryMax=${SIZE_MEMORY[$size]}" "CPUQuota=$((cores * 100))%" "AllowedCPUs=$(cpus "$1" "$cores")"
}

boot() {
  network "$1"
  admit "$1"
  limit "$1"
  systemctl start "$(unit "$1")"
}

start() {
  boot "$1"
  used "$1"
}

# Sets ENTER to the command that runs its arguments inside a running sandbox
# as the agent user. The scope puts that command under the sandbox's slice, so
# it counts against the same memory, CPU and task limits as the container.
# systemd-run would otherwise expand ${...} in the command (with its own,
# daemon-set environment) before the sandbox's shell ever saw it.
enter() {
  local leader
  leader=$(machinectl show "ab-$1" --property=Leader --value 2>/dev/null) || return 1
  ENTER=(
    systemd-run --quiet --scope --collect --expand-environment=no --slice="$(slice "$1")" --
    nsenter --target="$leader" --all --root --wdns=/home/agent --setuid=1000 --setgid=100 --
    /run/current-system/sw/bin/env -i
    HOME=/home/agent USER=agent LOGNAME=agent LANG=C.UTF-8 TERM="${TERM:-dumb}"
    AGENTBOX_HOST="$1.$DOMAIN"
    SHELL=/run/current-system/sw/bin/bash
    PATH=/run/wrappers/bin:/home/agent/.nix-profile/bin:/etc/profiles/per-user/agent/bin:/nix/var/nix/profiles/default/bin:/run/current-system/sw/bin
  )
}

remove() {
  systemctl stop "$(unit "$1")"
  btrfs subvolume delete --recursive "$BOXES/$1" >/dev/null
  release "$1"
  rm -f "$NET/$1" "$NETWORKD/40-agentbox-$1.network" "$DNS_DIR/$1" "$META/$1".{used,keep,env,net,size}
  networkctl reload
  # dnsmasq notices new hostsdir files by itself, but forgets removed ones
  # only when it rereads them.
  systemctl kill --signal=HUP dnsmasq.service 2>/dev/null || true
}

declared() {
  local known
  for known in "${ENV_NAMES[@]}"; do [[ $known == "$1" ]] && return 0; done
  return 1
}

# NUL-separated KEY=value pairs for the variables NAME opted into.
envs() {
  local key
  while IFS= read -r key; do
    declared "$key" || continue
    if [[ -v ENV_VALUES[$key] ]]; then
      printf '%s=%s\0' "$key" "${ENV_VALUES[$key]}"
    elif [[ -r $ENV_DIR/$key ]]; then
      printf '%s=%s\0' "$key" "$(<"$ENV_DIR/$key")"
    else
      echo "agentbox: $key is not resolved yet (check opnix-secrets.service)" >&2
    fi
  done <"$META/$1.env"
}

# Expiry. The idle clock is the mtime of META/NAME.used, refreshed by create,
# start and every exec. Sandboxes without one (created before expiry existed)
# start their clock the first time it is read.
used() {
  install -d -m 0700 "$META"
  touch "$META/$1.used"
}

idle() {
  [[ -f $META/$1.used ]] || used "$1"
  echo $(($(date +%s) - $(stat -c %Y "$META/$1.used")))
}

# A process entered with exec (an attached shell, a cloud-mode bash session
# and anything it started) holds a scope directly in the sandbox's slice; the
# container's own processes sit under its service instead.
attached() {
  local scope
  for scope in "/sys/fs/cgroup/agentbox.slice/$(slice "$1")"/*.scope; do
    [[ -d $scope ]] && return 0
  done
  return 1
}

# Prints "forever", the epoch a keep lasts until, or nothing. When a keep
# lapses the idle clock restarts, so the sandbox gets the usual grace period.
kept() {
  local until
  [[ -f $META/$1.keep ]] || return 0
  until=$(<"$META/$1.keep")
  if [[ $until == forever ]] || ((until > $(date +%s))); then
    echo "$until"
  else
    rm -f "$META/$1.keep"
    used "$1"
  fi
}

seconds() {
  [[ ${1-} =~ ^([0-9]{1,4})([hdw])$ ]] || die "invalid duration '${1-}' (like 12h, 30d, 2w, forever or off)"
  local n=$((10#${BASH_REMATCH[1]}))
  case ${BASH_REMATCH[2]} in
  h) echo $((n * 3600)) ;;
  d) echo $((n * 86400)) ;;
  w) echo $((n * 604800)) ;;
  esac
}

human() {
  if (($1 < 3600)); then
    echo "$(($1 / 60))m"
  elif (($1 < 172800)); then
    echo "$(($1 / 3600))h"
  else
    echo "$(($1 / 86400))d"
  fi
}

expiry() {
  local until left
  until=$(kept "$1")
  if [[ $until == forever ]]; then
    echo "kept"
  elif [[ -n $until ]]; then
    echo "kept until $(date -d "@$until" '+%F %H:%M')"
  else
    left=$(($(seconds "$EXPIRE_AFTER") - $(idle "$1")))
    if ((left > 0)); then echo "expires in $(human "$left")"; else echo "expires next reap"; fi
  fi
}

# Bundles the branches, tags and uncommitted work of every repo under the agent's
# home into ARCHIVE/NAME/STAMP and prints that directory (nothing when there was
# nothing to keep). Uncommitted work, untracked files included, becomes a commit
# on HEAD at refs/agentbox/wip, built in a scratch index so the repo's own index
# and working tree stay as they were. MANIFEST maps each bundle to its repo path
# and origin, IDENTITY holds the agent's git name and email, so `restore` can put
# everything back. git runs inside the sandbox as its agent, as for `agentbox
# collect`: root never opens a sandbox's repos itself, and what it writes down is
# passed back in only as arguments. Fails on any repo that has refs but cannot be
# bundled, so nothing committed is lost unarchived.
MANIFEST=repos.tsv
IDENTITY=identity
archive() {
  local name=$1 repos repo dir file url
  enter "$name" || return 1
  repos=$("${ENTER[@]}" bash -c 'find /home/agent -maxdepth 6 -name .git -prune -printf "%h\n" 2>/dev/null; true' </dev/null) || return 1
  dir=$ARCHIVE/$name/$(date +%Y%m%d-%H%M%S)
  install -d -m 0750 -g agentbox "$ARCHIVE" "$ARCHIVE/$name" "$dir" || return 1
  while IFS= read -r repo; do
    [[ $repo == /home/agent/* ]] || continue
    file=$dir/$(printf '%s' "${repo#/home/agent/}" | tr -c 'A-Za-z0-9._-' '_').bundle
    # shellcheck disable=SC2016 # expanded by the shell inside the sandbox
    if ! "${ENTER[@]}" bash -c '
      set -e
      cd "$1"
      [ -n "$(git for-each-ref --count=1 refs/heads refs/tags)" ] || exit 0
      if git rev-parse -q --verify HEAD >/dev/null; then
        index=$(mktemp)
        GIT_INDEX_FILE=$index git read-tree HEAD
        GIT_INDEX_FILE=$index git add -A
        tree=$(GIT_INDEX_FILE=$index git write-tree)
        rm -f "$index"
        if [ "$tree" != "$(git rev-parse "HEAD^{tree}")" ]; then
          git update-ref refs/agentbox/wip "$(git commit-tree "$tree" -p HEAD -m "agentbox: uncommitted work")"
        else
          git update-ref -d refs/agentbox/wip 2>/dev/null || true
        fi
      fi
      git bundle create - HEAD --branches --tags "--glob=refs/agentbox/*"
    ' _ "$repo" </dev/null >"$file" 2>/dev/null; then
      echo "agentbox: $name: could not bundle $repo" >&2
      rm -rf -- "$dir"
      return 1
    fi
    if [[ -s $file ]]; then
      chmod 0640 "$file"
      url=$("${ENTER[@]}" git -C "$repo" remote get-url origin </dev/null 2>/dev/null | tr -d '\t\n' || true)
      printf '%s\t%s\t%s\n' "${file##*/}" "$repo" "$url" >>"$dir/$MANIFEST"
    else
      rm -f "$file"
    fi
  done <<<"$repos"
  if rmdir "$dir" 2>/dev/null; then
    rmdir "$ARCHIVE/$name" 2>/dev/null || true
    return
  fi
  "${ENTER[@]}" bash -c 'git config --global user.name; git config --global user.email' </dev/null 2>/dev/null |
    tr -d '\t' | head -n 2 >"$dir/$IDENTITY" || true
  chmod 0640 "$dir/$MANIFEST" "$dir/$IDENTITY"
  echo "$dir"
}

# Clones every bundle of an archive back into a running sandbox at its old path,
# with its branches, tags, origin and git identity, and lays any uncommitted work
# (refs/agentbox/wip) back over the checkout.
restore() {
  local name=$1 dir=$2 file repo url user email
  enter "$name" || return 1
  [[ -f $dir/$MANIFEST ]] || return 0
  { read -r user && read -r email; } 2>/dev/null <"$dir/$IDENTITY" || true
  while IFS=$'\t' read -r file repo url; do
    [[ $repo == /home/agent/* && -s $dir/$file ]] || continue
    # shellcheck disable=SC2016 # expanded by the shell inside the sandbox
    "${ENTER[@]}" bash -c '
      set -euo pipefail
      bundle=$(mktemp)
      cat >"$bundle"
      mkdir -p "$(dirname "$1")"
      git clone -q "$bundle" "$1"
      cd "$1"
      git fetch -q --update-head-ok "$bundle" "+refs/heads/*:refs/heads/*" "+refs/tags/*:refs/tags/*" "+refs/agentbox/*:refs/agentbox/*"
      rm -f "$bundle"
      git for-each-ref --format="%(refname)" refs/remotes/origin | while read -r ref; do git update-ref -d "$ref"; done
      if [[ -n $2 ]]; then git remote set-url origin "$2"; else git remote remove origin; fi
      if [[ -n $3 ]]; then git config --global user.name "$3"; fi
      if [[ -n $4 ]]; then git config --global user.email "$4"; fi
      if git rev-parse -q --verify refs/agentbox/wip >/dev/null; then
        git restore --source=refs/agentbox/wip --worktree -- .
      fi
    ' _ "$repo" "$url" "${user-}" "${email-}" <"$dir/$file" || echo "agentbox: $name: could not restore $repo from $dir/$file" >&2
  done <"$dir/$MANIFEST"
}

# Archive, then remove; skipped when the sandbox was used meanwhile.
expire() {
  local name=$1 stamp dir
  stamp=$(stat -c %Y "$META/$name.used")
  if [[ $(state "$name") != running ]]; then boot "$name" || return 1; fi
  dir=$(archive "$name") || return 1
  [[ $(stat -c %Y "$META/$name.used") == "$stamp" ]] || return 0
  remove "$name"
  echo "agentbox: removed $name, idle since $(date -d "@$stamp" '+%F %H:%M')${dir:+; branches archived in $dir}"
}

# Run hourly by agentbox-reap.timer.
reap() {
  local box name idle dir now stop_after expire_after archive_ttl
  stop_after=$(seconds "$STOP_AFTER")
  expire_after=$(seconds "$EXPIRE_AFTER")
  archive_ttl=$(seconds "$ARCHIVE_TTL")
  for box in "$BOXES"/*; do
    [[ -d $box ]] || continue
    name=${box##*/}
    [[ -z $(kept "$name") ]] || continue
    if attached "$name"; then
      used "$name"
      continue
    fi
    idle=$(idle "$name")
    if ((idle >= expire_after)); then
      if ! expire "$name"; then
        echo "agentbox: could not archive $name; keeping it until the next reap" >&2
        systemctl stop "$(unit "$name")"
      fi
    elif ((idle >= stop_after)) && [[ $(state "$name") == running ]]; then
      systemctl stop "$(unit "$name")"
      echo "agentbox: stopped $name, idle for $(human "$idle")"
    fi
  done
  now=$(date +%s)
  for dir in "$ARCHIVE"/*/*; do
    [[ -d $dir ]] || continue
    if ((now - $(stat -c %Y "$dir") >= archive_ttl)); then rm -rf -- "$dir"; fi
  done
  for dir in "$ARCHIVE"/*; do
    if [[ -d $dir ]]; then rmdir "$dir" 2>/dev/null || true; fi
  done
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
    if attached "$name"; then use="in use"; else use="idle $(human "$(idle "$name")")"; fi
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$name" "$(state "$name")" "$use" "$(expiry "$name")" "$where" \
      "$(profile "$name")" "$(size_of "$name")"
  done
  ;;
net-sync)
  # Run after the firewall starts: kernel sets are empty after a reboot or
  # when first created.
  for file in "$NET"/*; do
    [[ -f $file ]] || continue
    name=${file##*/}
    if [[ -d $BOXES/$name ]]; then admit "$name"; fi
  done
  ;;
net)
  valid "${1-}"
  name=$1
  [[ -d $BOXES/$name ]] || die "no sandbox named $name"
  if (($# > 1)); then
    member "$2" "${NET_NAMES[@]}" || die "unknown net profile '$2' (${NET_NAMES[*]})"
    old=$(profile "$name")
    install -d -m 0700 "$META"
    echo "$2" >"$META/$name.net"
    admit "$name"
    if [[ $2 != "$old" ]] && ! member "$2" "${NET_OPEN[@]}"; then forget "$name"; fi
  fi
  profile "$name"
  ;;
size)
  valid "${1-}"
  name=$1
  [[ -d $BOXES/$name ]] || die "no sandbox named $name"
  if (($# > 1)); then
    member "$2" "${SIZE_NAMES[@]}" || die "unknown size '$2' (${SIZE_NAMES[*]})"
    install -d -m 0700 "$META"
    echo "$2" >"$META/$name.size"
    if [[ $(state "$name") == running ]]; then limit "$name"; fi
  fi
  size_of "$name"
  ;;
reap)
  reap
  ;;
keep)
  valid "${1-}"
  [[ -d $BOXES/$1 ]] || die "no sandbox named $1"
  install -d -m 0700 "$META"
  case ${2-} in
  forever) echo forever >"$META/$1.keep" ;;
  off)
    rm -f "$META/$1.keep"
    used "$1"
    ;;
  *)
    ttl=$(seconds "${2-}")
    echo $(($(date +%s) + ttl)) >"$META/$1.keep"
    ;;
  esac
  printf '%s: %s\n' "$1" "$(expiry "$1")"
  ;;
archived)
  valid "${1-}"
  for dir in "$ARCHIVE/$1"/*; do
    if [[ -d $dir ]]; then latest=$dir; fi
  done
  echo "${latest-}"
  ;;
state)
  valid "${1-}"
  state "$1"
  ;;
recreate)
  # Moves a sandbox onto the current base image, keeping its repos (uncommitted work
  # included), env opt-ins, keep, net profile, size and address; anything else in it
  # starts fresh.
  valid "${1-}"
  name=$1
  [[ -d $BOXES/$name ]] || die "no sandbox named $name"
  [[ -L $BASES/current ]] || die "no base image yet; check agentbox-base.service"
  if [[ $(state "$name") != running ]]; then boot "$name"; fi
  dir=$(archive "$name") || die "could not archive $name; it is unchanged"
  saved=$(mktemp -d)
  cp -p "$NET/$name" "$saved/index"
  for kind in env keep net size; do
    if [[ -f $META/$name.$kind ]]; then cp -p "$META/$name.$kind" "$saved/$kind"; fi
  done
  remove "$name"
  install -d -m 0700 "$NET" "$META"
  cp -p "$saved/index" "$NET/$name"
  for kind in env keep net size; do
    if [[ -f $saved/$kind ]]; then cp -p "$saved/$kind" "$META/$name.$kind"; fi
  done
  rm -rf -- "$saved"
  btrfs subvolume snapshot "$(readlink -f "$BASES/current")" "$BOXES/$name" >/dev/null
  start "$name"
  if [[ -n $dir ]]; then restore "$name" "$dir"; fi
  echo "agentbox: recreated $name on $(readlink "$BASES/current")${dir:+; repos restored from $dir, which stays as a backup}"
  ;;
create)
  valid "${1-}"
  name=$1
  shift
  net=$DEFAULT_NET
  size=$DEFAULT_SIZE
  while (($#)); do
    case $1 in
    --net)
      member "${2-}" "${NET_NAMES[@]}" || die "unknown net profile '${2-}' (${NET_NAMES[*]})"
      net=$2
      ;;
    --size)
      member "${2-}" "${SIZE_NAMES[@]}" || die "unknown size '${2-}' (${SIZE_NAMES[*]})"
      size=$2
      ;;
    *) die "unknown option for create: $1" ;;
    esac
    shift 2
  done
  [[ -L $BASES/current ]] || die "no base image yet; check agentbox-base.service"
  [[ ! -e $BOXES/$name ]] || die "sandbox $name already exists"
  install -d -m 0700 "$META"
  echo "$net" >"$META/$name.net"
  echo "$size" >"$META/$name.size"
  btrfs subvolume snapshot "$(readlink -f "$BASES/current")" "$BOXES/$name" >/dev/null
  start "$name"
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
  remove "$1"
  ;;
exec)
  valid "${1-}"
  name=$1
  shift
  [[ ${1-} == -- ]] && shift
  (($#)) || die "usage: agentbox-root exec NAME -- COMMAND..."
  enter "$name" || die "sandbox $name is not running (agentbox start $name)"
  used "$name"
  if [[ -s $META/$name.env ]]; then
    # Values travel on an inherited descriptor (fd 3: an unlinked root-only
    # file on tmpfs) and are exported inside, so they never appear in a
    # command line on the host or in the sandbox.
    values=$(mktemp -p /run/agentbox)
    envs "$name" >"$values"
    exec 3<"$values"
    rm -f "$values"
    # shellcheck disable=SC2016 # expanded by the shell inside the sandbox
    exec "${ENTER[@]}" bash -c 'while IFS= read -r -d "" kv; do export "$kv"; done <&3; exec 3<&-; exec "$@"' _ "$@"
  fi
  exec "${ENTER[@]}" "$@"
  ;;
env)
  valid "${1-}"
  name=$1
  shift
  [[ -d $BOXES/$name ]] || die "no sandbox named $name"
  install -d -m 0700 "$META"
  if [[ ${1-} == --none ]]; then
    rm -f "$META/$name.env"
  elif (($#)); then
    for key in "$@"; do
      declared "$key" || die "$key is not in the sandbox env catalog (${ENV_NAMES[*]:-empty})"
    done
    printf '%s\n' "$@" >"$META/$name.env"
  fi
  if [[ -f $META/$name.env ]]; then cat "$META/$name.env"; fi
  ;;
*)
  die "usage: agentbox-root base|ls|state|create|recreate|start|stop|rm|exec|env|net|size|keep|archived|reap|net-sync ..."
  ;;
esac

# exebox: agent sandboxes on exe.dev VMs. It takes agentbox's command contract
# (ensure, exec, env, collect, keep, rm, ...), so cloud-mode drives either one
# the same way. Each sandbox is one VM in the account's pool; what exebox knows
# about it (VM name, seeded repo, last use, keep) lives in its state dir here.
# Set by Nix above this text: KNOWN_HOSTS, EXPIRE_DAYS, ARCHIVE_DAYS.

state_dir=${XDG_STATE_HOME:-$HOME/.local/state}/exebox
boxes=$state_dir/boxes
archive=$state_dir/archive
# The test suite swaps in a fake ssh that plays exe.dev and its VMs.
ssh_bin=${EXEBOX_SSH:-ssh}
identity=${EXEBOX_IDENTITY:-$HOME/.ssh/exe_dev.pub}
sockets=$HOME/.ssh/exebox

# exe.dev's host key is pinned, so a first unattended connection never stops
# at host key verification. exe.dev decides who you are from the first key it
# is offered, so ~/.ssh/exe_dev.pub (a public key the 1Password agent holds)
# makes ssh offer only that one; without it, the agent's order decides.
ssh_opts=(
  -o BatchMode=yes
  -o "UserKnownHostsFile=$KNOWN_HOSTS"
  -o StrictHostKeyChecking=yes
  -o ConnectTimeout=15
  -o ServerAliveInterval=30
  -o LogLevel=ERROR
)
if [[ -f $identity ]]; then ssh_opts+=(-i "$identity" -o IdentitiesOnly=yes); fi

die() {
  printf 'exebox: %s\n' "$*" >&2
  exit 1
}

note() { printf 'exebox: %s\n' "$*" >&2; }

now() { date +%s; }

# POSIX single quoting: the VM's login shell parses what ssh sends.
sq() {
  local s=$1 r="'\\''"
  printf "'%s'" "${s//\'/"$r"}"
}

quoted() {
  local out='' arg
  for arg in "$@"; do out+="$(sq "$arg") "; done
  printf '%s' "${out% }"
}

usage() {
  cat <<EOF
usage: exebox COMMAND [ARGS]
  ls                          list sandboxes and their state
  ensure NAME [--seed PATH [--from BOX]] [--net open] [--size CLASS]
                              create NAME as an exe.dev VM (seeding PATH's git
                              repo, or BOX's clone of it) or reuse it; prints
                              the directory inside that maps to PATH
  exec [--own] NAME [--] COMMAND...
                              run COMMAND in NAME (--own: on a connection of
                              its own, so killing exebox stops it)
  shell NAME                  interactive login shell in NAME
  collect NAME [REPO] [--into BOX]
                              fetch NAME's branches into REPO (or BOX's clone
                              of it) as sandbox/NAME/*
  env NAME [--none]           exe sandboxes take no catalog variables
  net NAME [open]             always open: exe.dev cannot restrict egress
  size NAME [CLASS]           show or set NAME's size: small (2 vCPU, 4 GB),
                              medium (4, 8 GB), large (8, 16 GB); it comes
                              out of the account's pool
  keep NAME DURATION|forever|off
                              exempt NAME from expiry for e.g. 12h, 30d, 2w
  reap                        remove sandboxes unused for $EXPIRE_DAYS days (run hourly)
  rm NAME [--yes]             delete NAME's VM and everything in it

Idle sandboxes are removed after $EXPIRE_DAYS days unused; their branches and
uncommitted work are archived first under $archive/NAME/, kept $ARCHIVE_DAYS days.
EOF
}

check_name() {
  [[ ${1-} =~ ^[a-z0-9][a-z0-9-]{0,30}$ ]] ||
    die "sandbox names are a-z, 0-9 and dashes, at most 31 characters: ${1:-(none)}"
}

box_dir() { printf '%s/%s' "$boxes" "$1"; }
get() { cat "$(box_dir "$1")/$2" 2>/dev/null; }
put() { printf '%s\n' "$3" >"$(box_dir "$1")/$2"; }
known() { [[ -f $(box_dir "$1")/vm ]]; }
need() { known "${1-}" || die "no sandbox named ${1:-(none)}"; }
forget() { rm -rf "$(box_dir "$1")"; }
touch_used() { put "$1" used "$(now)"; }

size_flags() {
  case $1 in
  small) echo --cpu=2 --memory=4GB ;;
  medium) echo --cpu=4 --memory=8GB ;;
  large) echo --cpu=8 --memory=16GB ;;
  *) die "unknown size class $1 (small, medium, large)" ;;
  esac
}

duration() {
  [[ $1 =~ ^([0-9]+)([hdw])$ ]] || die "durations look like 12h, 30d or 2w: $1"
  case ${BASH_REMATCH[2]} in
  h) echo $((BASH_REMATCH[1] * 3600)) ;;
  d) echo $((BASH_REMATCH[1] * 86400)) ;;
  w) echo $((BASH_REMATCH[1] * 604800)) ;;
  esac
}

# The exe.dev lobby: VM lifecycle only, no shell. A failure answers with
# {"error": ...}, which becomes the message.
api() {
  local out err errfile
  errfile=$(mktemp)
  if out=$("$ssh_bin" "${ssh_opts[@]}" -T exe.dev "$@" 2>"$errfile"); then
    rm -f "$errfile"
    printf '%s\n' "$out"
    return
  fi
  err=$(jq -r '.error // empty' 2>/dev/null <<<"$out") || err=
  [[ -n $err ]] || err=${out:-$(cat "$errfile")}
  rm -f "$errfile"
  die "ssh exe.dev $1: $err"
}

vm_field() { jq -r --arg n "$2" --arg f "$3" '.vms[]? | select(.vm_name == $n) | .[$f] // empty' <<<"$1"; }

# Short operations share one master connection per VM. Killing a multiplexed
# client leaves its remote command running, so commands that must stop with
# their client (shells, the agent's bash, --own) get a connection of their own.
on_vm() {
  local mode=$1 name=$2 conn
  shift 2
  case $mode in
  mux)
    mkdir -p "$sockets"
    chmod 700 "$sockets"
    conn=(-o ControlMaster=auto -o "ControlPath=$sockets/%C" -o ControlPersist=600 -T)
    ;;
  own) conn=(-o ControlMaster=no -o ControlPath=none -T) ;;
  tty) conn=(-o ControlMaster=no -o ControlPath=none -tt) ;;
  esac
  # The username form always routes, unlike <vm>.exe.xyz (docs/faq/ssh-destination).
  "$ssh_bin" "${ssh_opts[@]}" "${conn[@]}" -- "vm+$(get "$name" vm)@vm.exe.xyz" "$@"
}

run_in() {
  local name=$1
  shift
  on_vm mux "$name" "$(quoted "$@")"
}

# Host paths keep their home-relative place: ~/www/x -> <VM home>/www/x.
# Repos outside home land under <VM home>/<repo name>.
mapped() {
  local path=$1 top=$2 home=$3
  if [[ $path == "$HOME" ]]; then
    echo "$home"
  elif [[ $path == "$HOME"/* ]]; then
    echo "$home/${path#"$HOME"/}"
  else
    echo "$home/${top##*/}${path#"$top"}"
  fi
}

# Unlike agentbox's image, exeuntu is a stock Ubuntu: cloud-mode also needs
# ripgrep and coreutils timeout there.
# shellcheck disable=SC2016 # expanded by the shell inside the VM
bootstrap_script='
  set -euo pipefail
  missing=()
  command -v git >/dev/null || missing+=(git)
  command -v rg >/dev/null || missing+=(ripgrep)
  command -v timeout >/dev/null || missing+=(coreutils)
  if ((${#missing[@]})); then
    sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${missing[@]}" >/dev/null
  fi
'

# A new VM boots in seconds; its first boot may still be running when `new`
# returns. Finishing setup is idempotent, so an interrupted ensure resumes it.
setup() {
  local name=$1 tries=0 home
  [[ -z $(get "$name" home) ]] || return 0
  until on_vm own "$name" true 2>/dev/null; do
    ((++tries < 30)) || die "VM $(get "$name" vm) of $name does not accept SSH"
    sleep 2
  done
  on_vm mux "$name" "bash -c $(sq "$bootstrap_script")" || die "could not install git, ripgrep and timeout in $name"
  # shellcheck disable=SC2016 # the VM's $HOME
  home=$(on_vm mux "$name" 'printf %s "$HOME"') || die "cannot read the home directory of $name"
  put "$name" home "$home"
}

create() {
  local name=$1 size=$2 vm json url
  # VM names are exe.dev hostnames, unique across accounts: a random suffix
  # keeps a sandbox name from colliding with someone else's VM.
  vm="$name-$(printf '%06x' $((SRANDOM % 16777216)))"
  local args=(new --json "--name=$vm")
  # shellcheck disable=SC2207 # two fixed words
  if [[ -n $size ]]; then args+=($(size_flags "$size")); fi
  api "${args[@]}" >/dev/null
  mkdir -p "$(box_dir "$name")"
  put "$name" vm "$vm"
  put "$name" size "${size:--}"
  touch_used "$name"
  json=$(api ls --json)
  url=$(vm_field "$json" "$vm" https_url)
  put "$name" url "${url:-https://$vm.exe.xyz}"
  setup "$name"
}

# Only committed history travels: the bundle is plain data, built here (or in
# sandbox FROM, for a sandbox seeded from another's clone) and cloned inside,
# so the VM never sees the source checkout itself.
# shellcheck disable=SC2016 # expanded by the shell inside the VM
clone_script='
  set -euo pipefail
  bundle=$(mktemp)
  cat >"$bundle"
  mkdir -p "$(dirname "$1")"
  git clone -q "$bundle" "$1"
  rm -f "$bundle"
  if [[ -n $2 ]]; then git -C "$1" remote set-url origin "$2"; else git -C "$1" remote remove origin; fi
  if [[ -n $3 ]]; then git config --global user.name "$3"; fi
  if [[ -n $4 ]]; then git config --global user.email "$4"; fi
'

seed() {
  local name=$1 path=$2 from=${3-} home top dest src_dir url user email
  home=$(get "$name" home)
  put "$name" repo "$path"
  if ! top=$(git -C "$path" rev-parse --show-toplevel 2>/dev/null); then
    run_in "$name" mkdir -p "$(mapped "$path" "$path" "$home")"
    return
  fi
  put "$name" repo "$top"
  dest=$(mapped "$top" "$top" "$home")
  put "$name" dir "$dest"
  if [[ -n $from ]]; then
    src_dir=$(mapped "$top" "$top" "$(get "$from" home)")
    src() { run_in "$from" git -C "$src_dir" "$@"; }
  else
    src() { git -C "$top" "$@"; }
  fi
  url=$(src remote get-url origin 2>/dev/null || true)
  user=$(src config user.name || true)
  email=$(src config user.email || true)
  src bundle create - HEAD --branches --tags 2>/dev/null |
    run_in "$name" bash -c "$clone_script" _ "$dest" "$url" "$user" "$email" ||
    die "could not seed $name from ${from:-$top}"
}

latest_archive() {
  local d last=''
  for d in "$archive/$1"/*/; do [[ -d $d ]] && last=${d%/}; done
  printf '%s' "$last"
}

# Branches, tags, and uncommitted work as a commit on HEAD at refs/exebox/wip
# (built in a scratch index, so the checkout is untouched).
# shellcheck disable=SC2016 # expanded by the shell inside the VM
archive_script='
  set -euo pipefail
  cd "$1"
  [[ -n $(git for-each-ref --count=1) ]] || exit 0
  if git rev-parse -q --verify HEAD >/dev/null; then
    index=$(mktemp)
    trap "rm -f $index" EXIT
    GIT_INDEX_FILE=$index git read-tree HEAD
    GIT_INDEX_FILE=$index git add -A
    tree=$(GIT_INDEX_FILE=$index git write-tree)
    if [[ $tree != "$(git rev-parse "HEAD^{tree}")" ]]; then
      commit=$(git -c user.name="$(git config user.name || echo exebox)" -c user.email="$(git config user.email || echo exebox@invalid)" \
        commit-tree "$tree" -p HEAD -m "wip: uncommitted work")
      git update-ref refs/exebox/wip "$commit"
    fi
  fi
  refs=(--branches --tags)
  if git rev-parse -q --verify refs/exebox/wip >/dev/null; then refs+=(refs/exebox/wip); fi
  git bundle create - "${refs[@]}" 2>/dev/null
'

archive_box() {
  local name=$1 dir out
  out="$archive/$name/$(date -u +%Y%m%dT%H%M%SZ)"
  mkdir -p "$out"
  if dir=$(get "$name" dir); then
    run_in "$name" bash -c "$archive_script" _ "$dir" >"$out/repo.bundle" || {
      rm -rf "$out"
      return 1
    }
    [[ -s $out/repo.bundle ]] || rm -f "$out/repo.bundle"
  fi
  get "$name" repo >"$out/repo" || true
  printf '%s' "$out"
}

idle_for() {
  local secs=$1
  if ((secs >= 86400)); then
    echo "$((secs / 86400))d"
  elif ((secs >= 3600)); then
    echo "$((secs / 3600))h"
  else
    echo "$((secs / 60))m"
  fi
}

cmd=${1-}
shift || true
case $cmd in
ls)
  printf '%-31s %-38s %-9s %-5s %-10s %-6s %s\n' NAME VM STATE IDLE KEEP SIZE REPO
  [[ -d $boxes ]] || exit 0
  json=$(api ls --json)
  for d in "$boxes"/*/; do
    [[ -f $d/vm ]] || continue
    name=$(basename "$d")
    vm=$(get "$name" vm)
    state=$(vm_field "$json" "$vm" status)
    keep=$(get "$name" keep || echo -)
    [[ $keep =~ ^[0-9]+$ ]] && keep="$(idle_for $((keep - $(now))))"
    printf '%-31s %-38s %-9s %-5s %-10s %-6s %s\n' "$name" "$vm" "${state:-gone}" \
      "$(idle_for $(($(now) - $(get "$name" used || echo 0))))" "$keep" "$(get "$name" size || echo -)" "$(get "$name" repo || echo -)"
  done
  ;;
ensure)
  name=${1-}
  shift || true
  check_name "$name"
  path=''
  from=''
  net=''
  size=''
  while (($#)); do
    case $1 in
    --seed)
      path=$(realpath -- "${2-}") || die "no such path: ${2-}"
      shift 2
      ;;
    --from)
      from=${2-}
      shift 2 || die "--from needs a sandbox name"
      ;;
    --net)
      net=${2-}
      shift 2 || die "--net needs a profile"
      ;;
    --size)
      size=${2-}
      shift 2 || die "--size needs a size class"
      ;;
    *) die "unknown option for ensure: $1" ;;
    esac
  done
  [[ -z $from || -n $path ]] || die "--from needs --seed PATH"
  [[ -z $from ]] || need "$from"
  # Refused rather than ignored: a caller asking for none or dev expects it enforced.
  [[ -z $net || $net == open ]] || die "exe.dev VMs have unrestricted outbound network; --net $net cannot be enforced there (only open)"
  if [[ -n $size ]]; then size_flags "$size" >/dev/null; fi
  mkdir -p "$boxes"
  if known "$name"; then
    json=$(api ls --json)
    vm=$(get "$name" vm)
    status=$(vm_field "$json" "$vm" status)
    if [[ -z $status ]]; then
      note "VM $vm of $name is gone from exe.dev; creating $name anew"
      forget "$name"
    fi
  fi
  if ! known "$name"; then
    create "$name" "$size"
    if [[ -n $path ]]; then seed "$name" "$path" "$from"; fi
    archived=$(latest_archive "$name")
    if [[ -n $archived ]]; then
      printf 'exebox: an earlier sandbox named %s expired; its branches are archived in %s\n' "$name" "$archived" >&2
    fi
  else
    # exe.dev documents `resize` but not a stop command, so a stopped VM is
    # started only if the lobby offers `start`; its error is passed on.
    if [[ $status == stopped ]]; then api start "$vm" >/dev/null; fi
    setup "$name"
    if [[ -n $size && $size != "$(get "$name" size)" ]]; then
      # shellcheck disable=SC2046 # two fixed words
      api resize "$vm" $(size_flags "$size") >/dev/null
      put "$name" size "$size"
    fi
  fi
  touch_used "$name"
  home=$(get "$name" home)
  if [[ -z $path ]]; then
    echo "$home"
  else
    top=$(git -C "$path" rev-parse --show-toplevel 2>/dev/null || echo "$path")
    mapped "$path" "$top" "$home"
  fi
  ;;
exec)
  own=''
  if [[ ${1-} == --own ]]; then
    own=1
    shift
  fi
  name=${1-}
  shift || true
  [[ ${1-} == -- ]] && shift
  need "$name"
  (($#)) || die "exec needs a command"
  touch_used "$name"
  # EXEBOX_URL plays AGENTBOX_HOST's part: where servers in the VM are reached.
  remote="EXEBOX_URL=$(sq "$(get "$name" url)"); export EXEBOX_URL; exec $(quoted "$@")"
  if [[ -t 0 ]]; then
    on_vm tty "$name" "$remote"
  elif [[ -n $own ]]; then
    on_vm own "$name" "$remote"
  else
    on_vm mux "$name" "$remote"
  fi
  ;;
shell)
  need "${1-}"
  touch_used "$1"
  on_vm tty "$1"
  ;;
collect)
  name=${1-}
  shift || true
  need "$name"
  repo=''
  into=''
  while (($#)); do
    case $1 in
    --into)
      into=${2-}
      shift 2 || die "--into needs a sandbox name"
      ;;
    *)
      repo=$1
      shift
      ;;
    esac
  done
  [[ -z $into ]] || need "$into"
  if [[ -z $repo ]]; then repo=$(get "$name" repo) || die "no repo recorded for $name; pass one"; fi
  repo=$(git -C "$repo" rev-parse --show-toplevel) || die "$repo is not a git repository"
  bundle=$(mktemp)
  trap 'rm -f "$bundle"' EXIT
  run_in "$name" git -C "$(mapped "$repo" "$repo" "$(get "$name" home)")" bundle create - --branches >"$bundle" 2>/dev/null ||
    die "could not bundle branches from $name"
  if [[ -n $into ]]; then
    # shellcheck disable=SC2016 # expanded by the shell inside the VM
    run_in "$into" bash -c '
      set -euo pipefail
      bundle=$(mktemp)
      cat >"$bundle"
      git -C "$1" -c fetch.fsckObjects=true fetch -q "$bundle" "+refs/heads/*:refs/remotes/sandbox/$2/*" || { rm -f "$bundle"; exit 1; }
      rm -f "$bundle"
      git -C "$1" for-each-ref --format="%(refname:short)" "refs/remotes/sandbox/$2"
    ' _ "$(mapped "$repo" "$repo" "$(get "$into" home)")" "$name" <"$bundle"
    touch_used "$into"
  else
    git -C "$repo" -c fetch.fsckObjects=true fetch -q "$bundle" "+refs/heads/*:refs/remotes/sandbox/$name/*"
    git -C "$repo" for-each-ref --format='%(refname:short)' "refs/remotes/sandbox/$name"
  fi
  touch_used "$name"
  ;;
env)
  need "${1-}"
  # There is no secret store to resolve a catalog from, and anything handed to
  # a VM can leave it; GitHub reads go through exe.dev's GitHub integration.
  if [[ $# -gt 1 && $2 != --none ]]; then
    shift
    die "exe sandboxes take no catalog variables (asked for: $*)"
  fi
  ;;
net)
  need "${1-}"
  [[ -z ${2-} || $2 == open ]] || die "exe.dev VMs have unrestricted outbound network; only open is possible"
  echo open
  ;;
size)
  name=${1-}
  need "$name"
  if [[ -n ${2-} ]]; then
    flags=$(size_flags "$2")
    # shellcheck disable=SC2086 # two fixed words
    api resize "$(get "$name" vm)" $flags >/dev/null
    put "$name" size "$2"
  fi
  get "$name" size
  ;;
keep)
  name=${1-}
  need "$name"
  case ${2-} in
  forever) put "$name" keep forever ;;
  off)
    rm -f "$(box_dir "$name")/keep"
    touch_used "$name"
    ;;
  *) put "$name" keep $(($(now) + $(duration "${2-}"))) ;;
  esac
  ;;
reap)
  [[ -d $boxes ]] || exit 0
  json=''
  procs=$(ps -Ao args=)
  for d in "$boxes"/*/; do
    [[ -f $d/vm ]] || continue
    name=$(basename "$d")
    vm=$(get "$name" vm)
    keep=$(get "$name" keep || true)
    [[ $keep == forever ]] && continue
    if [[ -n $keep ]]; then
      ((keep > $(now))) && continue
      # When a keep lapses, the idle clock restarts.
      rm -f "$d/keep"
      touch_used "$name"
      continue
    fi
    (($(now) - $(get "$name" used || echo 0) >= EXPIRE_DAYS * 86400)) || continue
    # An open shell or agent bash session counts as use.
    [[ $procs == *"vm+$vm@vm.exe.xyz"* ]] && continue
    [[ -n $json ]] || json=$(api ls --json)
    if [[ -z $(vm_field "$json" "$vm" status) ]]; then
      forget "$name"
      continue
    fi
    if saved=$(archive_box "$name"); then
      api rm "$vm" >/dev/null
      forget "$name"
      note "removed $name ($vm), unused for $EXPIRE_DAYS days; archived in $saved"
    else
      note "kept $name: its repository could not be archived"
    fi
  done
  if [[ -d $archive ]]; then
    find "$archive" -mindepth 2 -maxdepth 2 -type d -mtime +"$ARCHIVE_DAYS" -exec rm -rf {} +
    find "$archive" -mindepth 1 -maxdepth 1 -type d -empty -delete
  fi
  ;;
rm)
  name=${1-}
  need "$name"
  if [[ ${2-} != --yes ]]; then
    [[ -t 0 ]] || die "refusing to delete $name without --yes"
    read -r -p "Delete sandbox $name and everything in it? [y/N] " answer
    [[ $answer == [yY]* ]] || exit 1
  fi
  vm=$(get "$name" vm)
  if [[ -n $(vm_field "$(api ls --json)" "$vm" status) ]]; then api rm "$vm" >/dev/null; fi
  forget "$name"
  ;;
-h | --help | help | '')
  usage
  ;;
*)
  usage >&2
  exit 1
  ;;
esac

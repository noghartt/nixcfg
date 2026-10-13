# agentbox: agent sandboxes on this host. Unprivileged steps (git, state) run
# as the caller; everything touching a sandbox goes through agentbox-root,
# which agentbox-rootd runs on this process's own stdin, stdout and stderr.
# Set by Nix above this text: AGENTBOX_CLIENT, STOP_AFTER, EXPIRE_AFTER,
# ARCHIVE_TTL, NET_NAMES, DEFAULT_NET, SIZE_HELP, DEFAULT_SIZE.

state_dir=${XDG_STATE_HOME:-$HOME/.local/state}/agentbox

die() {
  printf 'agentbox: %s\n' "$*" >&2
  exit 1
}

root() { "$AGENTBOX_CLIENT" "$@"; }

usage() {
  cat <<EOF
usage: agentbox COMMAND [ARGS]
  ls                          list sandboxes and their state
  ensure NAME [--seed PATH [--from BOX]] [--net PROFILE] [--size CLASS]
                              create (seeding PATH's git repo, or BOX's clone
                              of it) or start NAME, with the given net profile
                              and size (also applied to an existing NAME);
                              prints the sandbox directory that maps to PATH
  exec NAME [--] COMMAND...   run COMMAND inside NAME as its agent user
  shell NAME                  interactive login shell inside NAME
  collect NAME [REPO] [--into BOX]
                              fetch NAME's branches into REPO (or BOX's clone
                              of it) as sandbox/NAME/*
  env NAME [KEY...|--none]    show, set or clear the catalog variables NAME's
                              commands get (declared in env-catalog.nix)
  net NAME [PROFILE]          show or set NAME's egress profile, at once:
                              ${NET_NAMES[*]} (net-profiles.nix; new sandboxes
                              get $DEFAULT_NET)
  size NAME [CLASS]           show or set NAME's size, at once: $SIZE_HELP
                              (new sandboxes get $DEFAULT_SIZE)
  keep NAME DURATION|forever|off
                              exempt NAME from expiry for e.g. 12h, 30d, 2w
  start|stop NAME
  recreate NAME [--yes]       rebuild NAME on the current image, keeping its
                              repos (uncommitted work too), env, keep, net and
                              size
  rm NAME [--yes]             delete NAME and everything in it

Idle sandboxes stop after $STOP_AFTER and are removed after $EXPIRE_AFTER unused; their
committed branches are archived first under /agent/archive/NAME/, kept $ARCHIVE_TTL.
EOF
}

# Host paths keep their home-relative place: ~/www/x -> /home/agent/www/x.
# Repos outside home land under /home/agent/<repo name>.
mapped() {
  local path=$1 top=$2
  if [[ $path == "$HOME" ]]; then
    echo /home/agent
  elif [[ $path == "$HOME"/* ]]; then
    echo "/home/agent/${path#"$HOME"/}"
  else
    echo "/home/agent/${top##*/}${path#"$top"}"
  fi
}

# Only committed history travels: the bundle is plain data, built here (or in
# sandbox FROM, for a sandbox seeded from another's clone, as orchestrator
# workers of a sandboxed leader are) and cloned inside, so the sandbox never
# sees the source checkout itself.
seed() {
  local name=$1 path=$2 from=${3-} top dest url user email
  if ! top=$(git -C "$path" rev-parse --show-toplevel 2>/dev/null); then
    root exec "$name" -- mkdir -p "$(mapped "$path" "$path")"
    return
  fi
  dest=$(mapped "$top" "$top")
  if [[ -n $from ]]; then
    src() { root exec "$from" -- git -C "$dest" "$@"; }
  else
    src() { git -C "$top" "$@"; }
  fi
  url=$(src remote get-url origin 2>/dev/null || true)
  user=$(src config user.name || true)
  email=$(src config user.email || true)
  # shellcheck disable=SC2016 # expanded by the shell inside the sandbox
  src bundle create - HEAD --branches --tags 2>/dev/null |
    root exec "$name" -- bash -c '
      set -euo pipefail
      bundle=$(mktemp)
      cat >"$bundle"
      mkdir -p "$(dirname "$1")"
      git clone -q "$bundle" "$1"
      rm -f "$bundle"
      if [[ -n $2 ]]; then git -C "$1" remote set-url origin "$2"; else git -C "$1" remote remove origin; fi
      if [[ -n $3 ]]; then git config --global user.name "$3"; fi
      if [[ -n $4 ]]; then git config --global user.email "$4"; fi
    ' _ "$dest" "$url" "$user" "$email"
  mkdir -p "$state_dir"
  printf '%s\n' "$top" >"$state_dir/$name.repo"
}

cmd=${1-}
shift || true
case $cmd in
ls)
  root ls
  ;;
ensure)
  name=${1-}
  shift || true
  path=
  from=
  net=
  size=
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
  status=$(root state "$name")
  if [[ $status != absent ]]; then
    if [[ -n $net ]]; then root net "$name" "$net" >/dev/null; fi
    if [[ -n $size ]]; then root size "$name" "$size" >/dev/null; fi
  fi
  case $status in
  absent)
    create=(create "$name")
    if [[ -n $net ]]; then create+=(--net "$net"); fi
    if [[ -n $size ]]; then create+=(--size "$size"); fi
    root "${create[@]}"
    if [[ -n $path ]]; then seed "$name" "$path" "$from"; fi
    archived=$(root archived "$name")
    if [[ -n $archived ]]; then
      printf 'agentbox: an earlier sandbox named %s expired; its branches are archived in %s\n' "$name" "$archived" >&2
    fi
    ;;
  stopped) root start "$name" ;;
  esac
  if [[ -z $path ]]; then
    echo /home/agent
  else
    top=$(git -C "$path" rev-parse --show-toplevel 2>/dev/null || echo "$path")
    mapped "$path" "$top"
  fi
  ;;
exec)
  name=${1-}
  shift || true
  [[ ${1-} == -- ]] && shift
  root exec "$name" -- "$@"
  ;;
shell)
  root exec "${1-}" -- bash -l
  ;;
collect)
  name=${1-}
  shift || true
  repo=
  into=
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
  if [[ -z $repo ]]; then repo=$(cat "$state_dir/$name.repo" 2>/dev/null) || die "no repo recorded for $name; pass one"; fi
  repo=$(git -C "$repo" rev-parse --show-toplevel) || die "$repo is not a git repository"
  bundle=$(mktemp)
  trap 'rm -f "$bundle"' EXIT
  root exec "$name" -- git -C "$(mapped "$repo" "$repo")" bundle create - --branches >"$bundle" 2>/dev/null ||
    die "could not bundle branches from $name"
  if [[ -n $into ]]; then
    # shellcheck disable=SC2016 # expanded by the shell inside the sandbox
    root exec "$into" -- bash -c '
      set -euo pipefail
      bundle=$(mktemp)
      cat >"$bundle"
      git -C "$1" -c fetch.fsckObjects=true fetch -q "$bundle" "+refs/heads/*:refs/remotes/sandbox/$2/*" || { rm -f "$bundle"; exit 1; }
      rm -f "$bundle"
      git -C "$1" for-each-ref --format="%(refname:short)" "refs/remotes/sandbox/$2"
    ' _ "$(mapped "$repo" "$repo")" "$name" <"$bundle"
  else
    git -C "$repo" -c fetch.fsckObjects=true fetch -q "$bundle" "+refs/heads/*:refs/remotes/sandbox/$name/*"
    git -C "$repo" for-each-ref --format='%(refname:short)' "refs/remotes/sandbox/$name"
  fi
  ;;
start | stop)
  root "$cmd" "${1-}"
  ;;
net | size)
  root "$cmd" "$@"
  ;;
keep)
  root keep "${1-}" "${2-}"
  ;;
env)
  root env "$@"
  ;;
recreate)
  name=${1-}
  if [[ ${2-} != --yes ]]; then
    [[ -t 0 ]] || die "refusing to recreate $name without --yes"
    read -r -p "Recreate sandbox $name? Its repos come back; everything else in it is lost. [y/N] " answer
    [[ $answer == [yY]* ]] || exit 1
  fi
  root recreate "$name"
  ;;
rm)
  name=${1-}
  if [[ ${2-} != --yes ]]; then
    [[ -t 0 ]] || die "refusing to delete $name without --yes"
    read -r -p "Delete sandbox $name and everything in it? [y/N] " answer
    [[ $answer == [yY]* ]] || exit 1
  fi
  root rm "$name"
  rm -f "$state_dir/$name.repo"
  ;;
-h | --help | help | '')
  usage
  ;;
*)
  usage >&2
  exit 1
  ;;
esac

# agentbox: agent sandboxes on this host. Unprivileged steps (git, state) run
# as the caller; everything touching a sandbox goes through agentbox-root.
# Set by Nix above this text: AGENTBOX_ROOT.

state_dir=${XDG_STATE_HOME:-$HOME/.local/state}/agentbox

die() {
  printf 'agentbox: %s\n' "$*" >&2
  exit 1
}

root() { /run/wrappers/bin/sudo -n "$AGENTBOX_ROOT" "$@"; }

usage() {
  cat <<'EOF'
usage: agentbox COMMAND [ARGS]
  ls                          list sandboxes and their state
  ensure NAME [--seed PATH]   create (seeding PATH's git repo) or start NAME;
                              prints the sandbox directory that maps to PATH
  exec NAME [--] COMMAND...   run COMMAND inside NAME as its agent user
  shell NAME                  interactive login shell inside NAME
  collect NAME [REPO]         fetch NAME's branches into REPO as sandbox/NAME/*
  start|stop NAME
  rm NAME [--yes]             delete NAME and everything in it
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

# Only committed history travels: the bundle is plain data, built here and
# cloned inside, so the sandbox never sees the host checkout itself.
seed() {
  local name=$1 path=$2 top dest url user email
  if ! top=$(git -C "$path" rev-parse --show-toplevel 2>/dev/null); then
    root exec "$name" -- mkdir -p "$(mapped "$path" "$path")"
    return
  fi
  dest=$(mapped "$top" "$top")
  url=$(git -C "$top" remote get-url origin 2>/dev/null || true)
  user=$(git -C "$top" config user.name || true)
  email=$(git -C "$top" config user.email || true)
  # shellcheck disable=SC2016 # expanded by the shell inside the sandbox
  git -C "$top" bundle create - HEAD --branches --tags 2>/dev/null |
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
  if [[ ${1-} == --seed ]]; then path=$(realpath -- "${2-}") || die "no such path: ${2-}"; fi
  case $(root state "$name") in
  absent)
    root create "$name"
    if [[ -n $path ]]; then seed "$name" "$path"; fi
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
  exec /run/wrappers/bin/sudo -n "$AGENTBOX_ROOT" exec "$name" -- "$@"
  ;;
shell)
  exec /run/wrappers/bin/sudo -n "$AGENTBOX_ROOT" exec "${1-}" -- bash -l
  ;;
collect)
  name=${1-}
  repo=${2:-$(cat "$state_dir/$name.repo" 2>/dev/null)} || die "no repo recorded for $name; pass one"
  repo=$(git -C "$repo" rev-parse --show-toplevel) || die "$repo is not a git repository"
  bundle=$(mktemp)
  trap 'rm -f "$bundle"' EXIT
  root exec "$name" -- git -C "$(mapped "$repo" "$repo")" bundle create - --branches >"$bundle" 2>/dev/null ||
    die "could not bundle branches from $name"
  git -C "$repo" -c fetch.fsckObjects=true fetch -q "$bundle" "+refs/heads/*:refs/remotes/sandbox/$name/*"
  git -C "$repo" for-each-ref --format='%(refname:short)' "refs/remotes/sandbox/$name"
  ;;
start | stop)
  root "$cmd" "${1-}"
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

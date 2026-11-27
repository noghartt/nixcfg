# Claude Code WorktreeCreate/WorktreeRemove hook: the same worktrees Claude
# makes itself (.claude/worktrees/<name> at the repository root, branch
# worktree-<name>, base per worktree.baseRef), but created with `git twig new`
# so tracked files are copy-on-write clones. A hook replaces Claude's own git
# logic entirely, so .worktreeinclude and branch cleanup are handled here.
# Only the worktree path may reach stdout.
set -euo pipefail

input=$(cat)
field() { jq -r --arg key "$1" '.[$key] // empty' <<<"$input"; }

create() {
  local name cwd root dir branch base_ref base
  name=$(field name)
  cwd=$(field cwd)
  [ -n "$name" ] || { echo "WorktreeCreate: no name in hook input" >&2; exit 1; }
  # The main checkout, also when Claude runs inside a linked worktree.
  root=$(dirname "$(git -C "$cwd" rev-parse --path-format=absolute --git-common-dir)")
  dir="$root/.claude/worktrees/${name//\//+}"
  branch="worktree-$name"

  # A resumed worktree session asks for the same name again.
  if [ -d "$dir" ]; then
    printf '%s\n' "$dir"
    return
  fi

  if ! git -C "$root" check-ignore -q "$dir"; then
    printf '/.claude/worktrees/\n' >>"$(git -C "$root" rev-parse --path-format=absolute --git-common-dir)/info/exclude"
  fi

  # Twig uses stock Git when the destination's parent is missing.
  mkdir -p "$(dirname "$dir")"
  if git -C "$root" show-ref --verify --quiet "refs/heads/$branch"; then
    git -C "$root" twig new "$dir" "$branch" >&2
  else
    base_ref=$(jq -r '.worktree.baseRef // "fresh"' "$HOME/.claude/settings.json" 2>/dev/null || echo fresh)
    base=HEAD
    if [ "$base_ref" = fresh ]; then
      git -C "$root" fetch --quiet origin >&2 2>&1 || true
      git -C "$root" remote set-head origin --auto >/dev/null 2>&1 || true
      if git -C "$root" rev-parse --verify --quiet 'refs/remotes/origin/HEAD^{commit}' >/dev/null; then
        base=refs/remotes/origin/HEAD
      fi
    fi
    # A commit, not the remote branch, so the new branch does not track origin.
    base=$(git -C "$root" rev-parse --verify "$base^{commit}")
    git -C "$root" twig new -b "$branch" "$dir" "$base" >&2
  fi

  # Gitignored files the project lists in .worktreeinclude (.env and the like).
  if [ -f "$root/.worktreeinclude" ]; then
    git -C "$root" ls-files -z --others --ignored --exclude-from=.worktreeinclude |
      while IFS= read -r -d '' file; do
        git -C "$root" check-ignore -q -- "$file" || continue
        mkdir -p "$dir/$(dirname "$file")"
        cp -p "$root/$file" "$dir/$file"
      done
  fi

  printf '%s\n' "$dir"
}

remove() {
  local path branch common
  path=$(field worktree_path)
  [ -n "$path" ] && [ -d "$path" ] || exit 0
  branch=$(git -C "$path" branch --show-current 2>/dev/null || true)
  common=$(git -C "$path" rev-parse --path-format=absolute --git-common-dir)
  git -C "$path" worktree remove --force "$path" >&2
  # Only the branch this hook created; Claude asked before removing a worktree with work in it.
  case "$branch" in
  worktree-*) git --git-dir="$common" branch -D "$branch" >&2 || true ;;
  esac
}

case "${1:-}" in
create) create ;;
remove) remove ;;
*)
  echo "usage: claude-worktree create|remove < hook-input.json" >&2
  exit 2
  ;;
esac

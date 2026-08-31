# shellcheck shell=bash
# Search Pi session history from a tmux popup.
#
# Typing fuzzy-matches session names, prompts, and paths. Ctrl-G searches the
# user/assistant transcript itself; Tab switches between this checkout and all
# checkouts. Selecting a session resumes it in a correctly rooted tmux window.

SESSION_ROOT="${PI_CODING_AGENT_SESSION_DIR:-${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/sessions}"
STATE="${PI_SESSION_SEARCH_STATE:-}"
TAB=$'\t'
DIM=$'\033[2m'
RST=$'\033[0m'
GRN=$'\033[32m'
YEL=$'\033[33m'
SELF="$0"

state_get() {
  local name="$1" fallback="${2:-}"
  if [[ -n "$STATE" && -f "$STATE/$name" ]]; then
    cat "$STATE/$name"
  else
    printf '%s' "$fallback"
  fi
}

state_set() {
  printf '%s' "$2" >"$STATE/$1"
}

content_text_filter='def text:
  if type == "string" then .
  elif type == "array" then [ .[] | select(.type == "text") | .text ] | join(" ")
  else "" end;'

metadata() {
  jq -rs "$content_text_filter
    (.[0].cwd // \"\") as \$cwd |
    ([.[] | select(.type == \"session_info\" and (.name // \"\") != \"\") | .name] | last // \"\") as \$name |
    ([.[] | select(.type == \"message\" and .message.role == \"user\") | .message.content | text] | first // \"untitled session\") as \$prompt |
    ([.[] | .timestamp // empty] | last // .[0].timestamp // \"\") as \$updated |
    [\$cwd, \$updated, (if \$name == \"\" then \$prompt else \$name end) |
      gsub(\"[\\t\\r\\n]+\"; \" \"
    )] | @tsv" "$1" 2>/dev/null
}

matches_transcript() {
  jq -ers --arg query "$2" "$content_text_filter
    [ .[] |
      if .type == \"message\" and (.message.role == \"user\" or .message.role == \"assistant\")
      then (.message.content | text)
      elif .type == \"compaction\" then (.summary // \"\")
      elif .type == \"branch_summary\" then (.summary // \"\")
      else empty end
    ] | join(\"\\n\") | ascii_downcase | contains(\$query | ascii_downcase)" "$1" >/dev/null 2>&1
}

build_list() {
  local scope query project file row cwd updated title short
  scope="$(state_get scope project)"
  query="$(state_get query)"
  project="$(state_get project "$PWD")"

  [[ -d "$SESSION_ROOT" ]] || return 0
  while IFS= read -r -d '' file; do
    row="$(metadata "$file")" || continue
    [[ -n "$row" ]] || continue
    IFS="$TAB" read -r cwd updated title <<<"$row"
    [[ "$scope" != project || "$cwd" == "$project" ]] || continue
    [[ -z "$query" ]] || matches_transcript "$file" "$query" || continue

    short="${cwd/#$HOME/~}"
    printf '%s\t%s\t%s\t%s  %s%-42.42s%s  %s\n' \
      "$file" "$cwd" "$updated" "${updated:5:11}" "$DIM" "$short" "$RST" "${title:0:100}"
  done < <(find "$SESSION_ROOT" -type f -name '*.jsonl' -print0 2>/dev/null) | sort -t "$TAB" -k3,3r
}

header() {
  local scope query label
  scope="$(state_get scope project)"
  query="$(state_get query)"
  label="$scope"
  if [[ -n "$query" ]]; then
    query="${query//[()]/}"
    [[ ${#query} -le 28 ]] || query="${query:0:28}…"
    label="$scope ${YEL}· transcript '$query'${RST}"
  fi
  printf 'scope: %s%s%s   tab scope · ^g transcript · ^p preview · enter resume' "$GRN" "$label" "$RST"
}

case "${1:-}" in
  --list)
    build_list
    exit 0
    ;;
  --cycle)
    if [[ "$(state_get scope project)" == project ]]; then
      state_set scope all
    else
      state_set scope project
    fi
    printf 'reload(%s --list)+change-header(%s)' "$SELF" "$(header)"
    exit 0
    ;;
  --grep)
    state_set query "${2:-}"
    printf 'reload(%s --list)+clear-query+change-header(%s)' "$SELF" "$(header)"
    exit 0
    ;;
  --preview)
    file="${2:-}"
    [[ -f "$file" ]] || exit 0
    jq -r "$content_text_filter
      . |
      if .type == \"message\" and .message.role == \"user\" then
        \"USER\n\" + (.message.content | text) + \"\\n\"
      elif .type == \"message\" and .message.role == \"assistant\" then
        \"ASSISTANT\n\" + (.message.content | text) + \"\\n\"
      elif .type == \"compaction\" then \"COMPACTION\n\" + (.summary // \"\") + \"\\n\"
      else empty end" "$file" 2>/dev/null | tail -n 240
    exit 0
    ;;
  --open)
    file="${2:-}"
    cwd="${3:-$HOME}"
    [[ -f "$file" ]] || exit 0
    [[ -d "$cwd" ]] || cwd="$HOME"
    printf -v command 'exec %q --session %q' '@PI@' "$file"
    tmux new-window -c "$cwd" "$command"
    exit 0
    ;;
esac

project="$(git rev-parse --show-toplevel 2>/dev/null || pwd -P)"
STATE="$(mktemp -d "${TMPDIR:-/tmp}/pi-session-search.XXXXXX")"
export PI_SESSION_SEARCH_STATE="$STATE"
trap 'rm -rf "$STATE"' EXIT
state_set scope project
state_set query ''
state_set project "$project"

list="$(build_list)"
[[ -n "$list" ]] || list="$(printf '\t\t\t%sno Pi sessions in this checkout — press Tab for all%s' "$DIM" "$RST")"

printf '%s\n' "$list" | fzf \
  --ansi --no-sort --layout=reverse --cycle \
  --delimiter='\t' --with-nth=4 \
  --prompt='❯ ' --info=inline-right --pointer='▶' --gutter=' ' \
  --color='pointer:green,prompt:green,info:dim,header:dim' \
  --header="$(header)" \
  --preview "$SELF --preview {1}" \
  --preview-window='right:55%:wrap:border-left' \
  --bind='ctrl-p:toggle-preview' \
  --bind="tab:transform:$SELF --cycle" \
  --bind="ctrl-g:transform:$SELF --grep {q}" \
  --bind="enter:become($SELF --open {1} {2})" \
  --bind='ctrl-c:abort,esc:abort'

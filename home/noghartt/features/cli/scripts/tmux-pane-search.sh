# shellcheck shell=bash
# Fuzzy-search the scrollback of every live tmux pane.

SELF="$0"
TAB=$'\t'
DIM=$'\033[2m'
RST=$'\033[0m'
GRN=$'\033[32m'

list_lines() {
  local pane session window_index window_name pane_index command line_number text target

  while IFS="$TAB" read -r pane session window_index window_name pane_index command; do
    target="$session:$window_index.$pane_index $window_name"
    line_number=0

    while IFS= read -r text || [[ -n "$text" ]]; do
      ((line_number += 1))
      [[ -n "${text//[[:space:]]/}" ]] || continue
      text="${text//$'\t'/ }"
      printf '%s\t%s\t%s%s%s  %s%s%s  %s\n' \
        "$pane" "$line_number" "$GRN" "$target" "$RST" "$DIM" "$command" "$RST" "$text"
    done < <(tmux capture-pane -p -S - -t "$pane")
  done < <(
    tmux list-panes -a -F "#{pane_id}${TAB}#{session_name}${TAB}#{window_index}${TAB}#{window_name}${TAB}#{pane_index}${TAB}#{pane_current_command}"
  )
}

preview_line() {
  local pane="$1" selected="$2"

  tmux capture-pane -p -S - -t "$pane" | awk -v selected="$selected" '
    NR >= selected - 20 && NR <= selected + 20 {
      prefix = (NR == selected) ? "\033[32;1m>" : "\033[2m "
      suffix = (NR == selected) ? "\033[0m" : "\033[0m"
      printf "%s%6d  %s%s\n", prefix, NR, $0, suffix
    }
  '
}

open_line() {
  local pane="$1" line="$2" session
  [[ "$pane" == %* && "$line" =~ ^[0-9]+$ ]] || exit 0
  tmux display-message -p -t "$pane" '#{pane_id}' >/dev/null 2>&1 || exit 0

  session="$(tmux display-message -p -t "$pane" '#{session_id}')"
  tmux switch-client -t "$session"
  tmux select-window -t "$pane"
  tmux select-pane -t "$pane"
  tmux copy-mode -t "$pane"
  tmux send-keys -X -t "$pane" history-top
  if ((line > 1)); then
    tmux send-keys -X -N "$((line - 1))" -t "$pane" cursor-down
  fi
}

case "${1:-}" in
  --list)
    list_lines
    exit 0
    ;;
  --preview)
    preview_line "${2:-}" "${3:-}"
    exit 0
    ;;
  --open)
    open_line "${2:-}" "${3:-}"
    exit 0
    ;;
esac

selection="$(
  list_lines | fzf \
    --ansi --no-sort --layout=reverse --cycle \
    --delimiter='\t' --with-nth=3 \
    --prompt='❯ ' --info=inline-right --pointer='▶' --gutter=' ' \
    --color='pointer:green,prompt:green,info:dim,header:dim' \
    --header='all live panes · enter jump to copy mode · ^p preview' \
    --preview "$SELF --preview {1} {2}" \
    --preview-window='right:55%:wrap:border-left' \
    --bind='ctrl-p:toggle-preview' \
    --bind='ctrl-c:abort,esc:abort'
)" || exit 0

IFS="$TAB" read -r pane line _ <<<"$selection"
open_line "$pane" "$line"

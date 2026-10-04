#!/bin/sh
# Close every linked-worktree workspace of the focused workspace's repository.
# The primary checkout's workspace is never touched, so this works from either
# the primary workspace or one of its worktrees.
set -u

herdr=${HERDR_BIN_PATH:-herdr}
tab=$(printf '\t')

read_key() {
	stty -icanon -echo 2>/dev/null
	key=$(dd bs=1 count=1 2>/dev/null)
	stty icanon echo 2>/dev/null
}

pause() {
	printf '\nPress any key to close.'
	read_key
}

error_message() {
	printf '%s' "$1" | jq -er '.error.message' 2>/dev/null || printf '%s' "$1"
}

ctx=${HERDR_PLUGIN_CONTEXT_JSON:-"{}"}
repo_key=$(printf '%s' "$ctx" | jq -r '.worktree.repo_key // empty')
repo_name=$(printf '%s' "$ctx" | jq -r '.worktree.repo_name // empty')
current=$(printf '%s' "$ctx" | jq -r '.workspace_id // empty')

if [ -z "$repo_key" ]; then
	printf 'The focused workspace is not a Git checkout.\n'
	pause
	exit 0
fi

if ! list=$("$herdr" workspace list 2>&1); then
	error_message "$list"
	pause
	exit 1
fi

# The focused workspace goes last, in case closing it disturbs this popup.
targets=$(printf '%s' "$list" | jq -r --arg key "$repo_key" --arg current "$current" '
	[.result.workspaces[]
		| select(.worktree.repo_key == $key and .worktree.is_linked_worktree)]
	| sort_by(.workspace_id == $current)
	| .[] | [.workspace_id, .label, .worktree.checkout_path] | @tsv')

if [ -z "$targets" ]; then
	printf 'No open worktree workspaces for %s.\n' "$repo_name"
	pause
	exit 0
fi

printf 'Worktree workspaces of %s:\n\n' "$repo_name"
printf '%s\n' "$targets" | while IFS=$tab read -r _ label path; do
	printf '  %-24s %s\n' "$label" "$path"
done
printf '\n  [c] close the workspaces, keep the checkouts\n'
printf '  [r] remove the checkouts (git worktree remove; dirty ones are kept)\n'
printf '  any other key cancels\n'
read_key

case $key in
c | C) mode=close ;;
r | R) mode=remove ;;
*) exit 0 ;;
esac

act() {
	if [ "$mode" = close ]; then
		"$herdr" workspace close "$1"
	else
		"$herdr" worktree remove --workspace "$1"
	fi
}

printf '\n'
failed=0
while IFS=$tab read -r id label _; do
	if out=$(act "$id" 2>&1); then
		printf '  done    %s\n' "$label"
	else
		failed=$((failed + 1))
		printf '  failed  %s: %s\n' "$label" "$(error_message "$out")"
	fi
done <<EOF
$targets
EOF

if [ "$failed" -gt 0 ]; then
	[ "$mode" = remove ] &&
		printf '\nForce a dirty checkout with: herdr worktree remove --workspace <id> --force\n'
	pause
fi

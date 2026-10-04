#!/bin/sh
# gh as seen by AI harnesses only: their wrappers put this directory first on
# PATH. Posting GitHub comments or reviews speaks for the user in public, so
# agents may only draft that text; the user posts it. Everything else,
# including PR/issue bodies and all reads, goes to the real gh untouched.

refuse() {
  [ -n "${stdin_copy:-}" ] && rm -f "$stdin_copy"
  cat >&2 <<EOF
gh (agent guard): refused \`$1\`.
Agents must not post, edit, or reply to GitHub comments or reviews on the
user's behalf without explicit permission. Do not work around this block
(another gh binary, curl, raw API calls, aliases, scripts). Draft the comment
or review text in your reply instead and let the user post it.
EOF
  exit 1
}

# pflag accepts -c text, -ctext, and -dc text (bundled with the delete-branch
# boolean) as well as the long forms.
has_comment_flag() {
  for arg do
    case $arg in
      --) return 1 ;;
      --comment | --comment=*) return 0 ;;
      -c* | -dc*) return 0 ;;
    esac
  done
  return 1
}

api_value() {
  case $1 in
    -X | --method) method=$2 ;;
    -f | -F | --raw-field | --field)
      has_body=1
      body="$body
$2"
      case $2 in
        *=@-) reads_stdin=1 ;;
        *=@*) files="$files${2#*=@}
" ;;
      esac
      ;;
    --input)
      has_body=1
      if [ "$2" = - ]; then
        reads_stdin=1
      else
        files="$files$2
"
      fi
      ;;
  esac
}

# Mutation text can arrive inline, from key=@file / --input file, or on stdin;
# stdin is buffered so it can be scanned and still reach gh.
graphql_text() {
  printf '%s\n' "$body"
  printf '%s' "$files" | while IFS= read -r file; do
    cat -- "$file" 2>/dev/null
  done
  if [ -n "$stdin_copy" ]; then
    cat -- "$stdin_copy"
  fi
}

check_api() {
  method='' endpoint='' has_body='' body='' files='' reads_stdin='' expect=''
  for arg do
    if [ -n "$expect" ]; then
      api_value "$expect" "$arg"
      expect=''
      continue
    fi
    case $arg in
      -X | --method | -H | --header | -f | --raw-field | -F | --field | --input | \
        -q | --jq | -t | --template | --hostname | --cache | -p | --preview)
        expect=$arg
        ;;
      --*=*) api_value "${arg%%=*}" "${arg#*=}" ;;
      -X?* | -f?* | -F?*) api_value "${arg%"${arg#-?}"}" "${arg#-?}" ;;
      -*) ;;
      *) [ -z "$endpoint" ] && endpoint=$arg ;;
    esac
  done

  method=$(printf '%s' "$method" | tr '[:lower:]' '[:upper:]')
  if [ -z "$method" ]; then
    if [ -n "$has_body" ]; then method=POST; else method=GET; fi
  fi
  path=${endpoint%%\?*}
  path=${path%/}

  case $path in
    graphql | */graphql)
      if [ -n "$reads_stdin" ]; then
        stdin_copy=$(mktemp "${TMPDIR:-/tmp}/gh-guard.XXXXXX") || exit 1
        cat >"$stdin_copy"
      fi
      text=$(graphql_text)
      if printf '%s' "$text" | grep -q 'mutation' &&
        printf '%s' "$text" |
        grep -Eq '(add|update|delete|submit|dismiss|minimize)[A-Za-z]*(Comment|Review)'; then
        refuse "gh api graphql (comment/review mutation)"
      fi
      ;;
    *)
      case $method in
        GET | HEAD) ;;
        *)
          if printf '%s\n' "$path" |
            grep -Eq '(^|/)(comments|reviews)(/[^/]+(/(replies|events|dismissals))?)?$'; then
            refuse "gh api -X $method $endpoint"
          fi
          ;;
      esac
      ;;
  esac
}

stdin_copy=''
case ${1:-} in
  pr | issue)
    case "$1 ${2:-}" in
      "pr comment" | "issue comment" | "pr review") refuse "gh $1 $2" ;;
      "pr close" | "pr reopen" | "issue close" | "issue reopen")
        if has_comment_flag "$@"; then
          refuse "gh $1 $2 --comment"
        fi
        ;;
    esac
    ;;
  api)
    shift
    check_api "$@"
    set -- api "$@"
    ;;
esac

# Drop this directory from PATH so the real gh is found and gh's own children
# (extensions, credential helpers) never loop back here.
self_dir=$(dirname -- "$0")
self_phys=$(cd -P -- "$self_dir" 2>/dev/null && pwd -P) || self_phys=$self_dir
new_path=''
old_ifs=$IFS
IFS=:
set -f
for dir in $PATH; do
  [ "$dir" = "$self_dir" ] && continue
  if [ -x "$dir/gh" ] && [ "$(cd -P -- "$dir" 2>/dev/null && pwd -P)" = "$self_phys" ]; then
    continue
  fi
  new_path=${new_path:+$new_path:}$dir
done
set +f
IFS=$old_ifs
PATH=$new_path
export PATH

if ! command -v gh >/dev/null 2>&1; then
  echo "gh (agent guard): no real gh found on PATH" >&2
  exit 127
fi

if [ -n "$stdin_copy" ]; then
  exec <"$stdin_copy"
  rm -f "$stdin_copy"
fi
exec gh "$@"

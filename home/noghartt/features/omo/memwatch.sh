# Watches omo processes' memory footprint (Activity Monitor's "Memory" column).
# Above OMO_MEMWATCH_WARN_MB it records what the process holds and notifies,
# again each time it grows by half; above OMO_MEMWATCH_KILL_MB it records, then
# stops the process so the rest of the machine stays usable. Sessions are saved
# per entry, so a stopped omo loses only its in-flight turn.

warn_mb=${OMO_MEMWATCH_WARN_MB:-4096}
kill_mb=${OMO_MEMWATCH_KILL_MB:-12288}
state_dir=${XDG_STATE_HOME:-$HOME/.local/state}/omo-memwatch
log_dir=$HOME/Library/Logs/omo-memwatch
mkdir -p "$state_dir" "$log_dir"

notify() {
  /usr/bin/osascript -e "display notification \"$2\" with title \"$1\"" >/dev/null 2>&1 || true
}

snapshot() {
  local pid=$1 mb=$2 reason=$3 file cwd sessions
  file="$log_dir/$(/bin/date +%Y%m%dT%H%M%S)-$pid.txt"
  cwd=$(/usr/sbin/lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | /usr/bin/sed -n 's/^n//p' | /usr/bin/head -1)
  # OmO names a cwd's session directory by replacing every / with -.
  sessions="$HOME/.omo/agent/sessions/-${cwd//\//-}--"
  {
    echo "reason: $reason (${mb} MB footprint; warn ${warn_mb} MB, kill ${kill_mb} MB)"
    echo "cwd: $cwd"
    /bin/ps -o pid,ppid,etime,rss,command -p "$pid"
    echo
    echo "== newest sessions for this cwd"
    /bin/ls -lt "$sessions" 2>/dev/null | /usr/bin/head -4
    echo
    echo "== children"
    /bin/ps -axo pid,ppid,rss,command | /usr/bin/awk -v p="$pid" '$2 == p'
    echo
    echo "== footprint"
    /usr/bin/footprint "$pid" 2>&1 | /usr/bin/head -30
    echo
    echo "== vmmap -summary"
    /usr/bin/vmmap -summary "$pid" 2>&1 | /usr/bin/sed -n '/^REGION TYPE/,/^TOTAL/p'
  } >"$file" 2>&1
  echo "$file"
}

# Top 40 processes by footprint; MEM reads like 3567M, 12G+, 980K-.
/usr/bin/top -l 1 -o mem -n 40 -stats pid,mem,command |
  /usr/bin/awk '
    /^PID/ { rows = 1; next }
    rows && $3 == "omo" {
      v = $2; sub(/[+-]$/, "", v); u = substr(v, length(v)); n = substr(v, 1, length(v) - 1) + 0
      mb = u == "G" ? n * 1024 : u == "K" ? n / 1024 : u == "B" ? 0 : n
      printf "%s %d\n", $1, mb
    }' |
  while read -r pid mb; do
    [ "$mb" -ge "$warn_mb" ] || continue
    started=$(/bin/ps -o lstart= -p "$pid" 2>/dev/null) || continue
    state="$state_dir/$pid"
    last=0
    if [ -f "$state" ] && [ "$(/usr/bin/head -1 "$state")" = "$started" ]; then
      last=$(/usr/bin/sed -n 2p "$state")
    fi

    if [ "$mb" -ge "$kill_mb" ]; then
      file=$(snapshot "$pid" "$mb" "over kill limit, stopping")
      kill -TERM "$pid" 2>/dev/null || true
      for _ in 1 2 3 4 5 6 7 8 9 10; do
        kill -0 "$pid" 2>/dev/null || break
        sleep 1
      done
      kill -KILL "$pid" 2>/dev/null || true
      rm -f "$state"
      notify "omo stopped at $((mb / 1024)) GB" "pid $pid; details in $file"
    elif [ "$mb" -ge $((last * 3 / 2)) ]; then
      file=$(snapshot "$pid" "$mb" "over warn limit")
      printf '%s\n%s\n' "$started" "$mb" >"$state"
      notify "omo using $((mb / 1024)) GB" "pid $pid; details in $file"
    fi
  done

for state in "$state_dir"/*; do
  [ -e "$state" ] || continue
  kill -0 "${state##*/}" 2>/dev/null || rm -f "$state"
done
/usr/bin/find "$log_dir" -type f -mtime +30 -delete

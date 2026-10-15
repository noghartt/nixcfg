# exebox's contract tests, run at build time: a fake ssh plays the exe.dev
# lobby and its VMs with local directories, so the real script seeds, execs,
# collects, reaps and removes without an account or network.
# usage: bash test.sh /path/to/exebox
set -euo pipefail
exebox=$1
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
export HOME=$T/home XDG_STATE_HOME=$T/state FAKE_EXE=$T/exe EXEBOX_SSH=$T/bin/ssh EXEBOX_IDENTITY=$T/none
state=$XDG_STATE_HOME/exebox
mkdir -p "$HOME/www/proj" "$T/bin" "$FAKE_EXE/vms"

cat >"$EXEBOX_SSH" <<EOF
#!$(command -v bash)
EOF
cat >>"$EXEBOX_SSH" <<'EOF'
set -euo pipefail
while (($#)); do
  case $1 in
  -o | -i) shift 2 ;;
  --) shift; break ;;
  -*) shift ;;
  *) break ;;
  esac
done
dest=$1
shift
cmd="$*"
vms=$FAKE_EXE/vms
case $dest in
exe.dev)
  read -ra words <<<"$cmd"
  case ${words[0]} in
  new)
    for word in "${words[@]}"; do [[ $word == --name=* ]] && name=${word#--name=}; done
    mkdir -p "$vms/$name/home"
    printf '%s\n' "${words[*]}" >"$vms/$name/created"
    printf '{"vm_name":"%s"}\n' "$name"
    ;;
  ls)
    printf '{"vms":['
    sep=''
    for d in "$vms"/*/; do
      [[ -d $d ]] || continue
      n=$(basename "$d")
      printf '%s{"vm_name":"%s","status":"running","https_url":"https://%s.exe.xyz","ssh_dest":"%s.exe.xyz"}' "$sep" "$n" "$n" "$n"
      sep=,
    done
    printf ']}\n'
    ;;
  rm) rm -rf "${vms:?}/${words[1]}" ;;
  resize) printf '%s\n' "${words[*]}" >"$vms/${words[1]}/resized" ;;
  *)
    echo '{"error":"unknown command"}'
    exit 1
    ;;
  esac
  ;;
vm+*@vm.exe.xyz)
  name=${dest#vm+}
  name=${name%@vm.exe.xyz}
  [[ -d $vms/$name ]] || { echo "no VM $name" >&2; exit 255; }
  export HOME=$vms/$name/home
  cd "$HOME"
  exec bash -c "$cmd"
  ;;
*)
  echo "unexpected destination $dest" >&2
  exit 255
  ;;
esac
EOF
chmod +x "$EXEBOX_SSH"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}
vm_of() { cat "$state/boxes/$1/vm"; }
inside() { echo "$FAKE_EXE/vms/$(vm_of "$1")/home/www/proj"; }

git config --global user.name Tester
git config --global user.email tester@example.invalid
git config --global init.defaultBranch main
repo=$HOME/www/proj
git -C "$repo" init -q
echo a >"$repo/a"
git -C "$repo" add a
git -C "$repo" commit -qm one
git -C "$repo" remote add origin git@github.com:example/proj.git

# ensure: creates a VM, clones committed history, prints the mapped directory.
dir=$("$exebox" ensure p1 --seed "$repo")
[[ $dir == "$(inside p1)" ]] || fail "ensure printed $dir"
[[ $(git -C "$dir" log -1 --format=%s) == one ]] || fail "seed lost history"
[[ $(git -C "$dir" remote get-url origin) == git@github.com:example/proj.git ]] || fail "origin not kept"
[[ $(vm_of p1) =~ ^p1-[0-9a-f]{6}$ ]] || fail "VM name $(vm_of p1)"
mkdir "$repo/sub"
[[ $("$exebox" ensure p1 --seed "$repo/sub") == "$dir/sub" ]] || fail "existing ensure must map subdirectories"
[[ $(find "$FAKE_EXE/vms" -mindepth 1 -maxdepth 1 | wc -l) -eq 1 ]] || fail "second ensure created a VM"

# exec: quoting survives, exit status and EXEBOX_URL come back.
[[ $("$exebox" exec p1 -- printf '%s|' "a b" "it's" '$HOME') == "a b|it's|\$HOME|" ]] || fail "exec quoting"
[[ $("$exebox" exec p1 -- bash -c 'echo "$EXEBOX_URL"') == "https://$(vm_of p1).exe.xyz" ]] || fail "EXEBOX_URL"
set +e
"$exebox" exec p1 -- bash -c 'exit 7'
status=$?
set -e
((status == 7)) || fail "exec exit status $status"

# collect: the box's branches land as sandbox/NAME/*.
"$exebox" exec p1 -- bash -c 'cd www/proj && git switch -qc feat && echo b >b && git add b && git commit -qm two'
"$exebox" collect p1 | grep -qx sandbox/p1/feat || fail "collect did not list sandbox/p1/feat"
[[ $(git -C "$repo" log -1 --format=%s sandbox/p1/feat) == two ]] || fail "collected branch content"

# --from: a child clones its parent's committed HEAD; --into delivers back.
cdir=$("$exebox" ensure c1 --seed "$repo" --from p1)
[[ $(git -C "$cdir" log -1 --format=%s) == two ]] || fail "child not seeded from parent HEAD"
"$exebox" exec c1 -- bash -c 'cd www/proj && git switch -qc task/p1/x && echo c >c && git add c && git commit -qm three'
"$exebox" collect c1 --into p1 | grep -qx sandbox/c1/task/p1/x || fail "collect --into"
[[ $(git -C "$dir" log -1 --format=%s sandbox/c1/task/p1/x) == three ]] || fail "delivered branch content"

# Unenforceable or unknown options are refused.
"$exebox" ensure p2 --net dev 2>/dev/null && fail "--net dev accepted"
"$exebox" ensure p2 --size huge 2>/dev/null && fail "--size huge accepted"
"$exebox" ensure Bad_Name 2>/dev/null && fail "bad name accepted"
[[ ! -e $state/boxes/p2 ]] || fail "refused ensure left state"
"$exebox" ensure p1 --net open >/dev/null
"$exebox" env p1 GH_TOKEN 2>/dev/null && fail "env accepted a variable"
[[ -z $("$exebox" env p1) && -z $("$exebox" env p1 --none) ]] || fail "env output"
"$exebox" ensure p1 --size large >/dev/null
grep -q -- '--cpu=8 --memory=16GB' "$FAKE_EXE/vms/$(vm_of p1)/resized" || fail "size not applied"
[[ $("$exebox" size p1) == large ]] || fail "size not recorded"

# reap: idle boxes are archived (uncommitted work included), then removed.
cvm=$(vm_of c1)
"$exebox" exec c1 -- bash -c 'cd www/proj && echo wip >w'
echo 0 >"$state/boxes/c1/used"
"$exebox" reap 2>/dev/null
[[ ! -e $FAKE_EXE/vms/$cvm && ! -e $state/boxes/c1 ]] || fail "idle box not removed"
[[ -e $FAKE_EXE/vms/$(vm_of p1) ]] || fail "fresh box removed"
bundle=$(echo "$state"/archive/c1/*/repo.bundle)
git bundle list-heads "$bundle" | grep -q 'refs/exebox/wip$' || fail "wip not archived"
git bundle list-heads "$bundle" | grep -q 'refs/heads/task/p1/x$' || fail "branch not archived"
err=$("$exebox" ensure c1 --seed "$repo" 2>&1 >/dev/null)
[[ $err == *"expired; its branches are archived in $state/archive/c1/"* ]] || fail "no expiry notice: $err"

# keep: forever survives reaping; off restarts the idle clock.
"$exebox" keep p1 forever
echo 0 >"$state/boxes/p1/used"
"$exebox" reap 2>/dev/null
[[ -e $state/boxes/p1 ]] || fail "kept box removed"
"$exebox" keep p1 off
"$exebox" reap 2>/dev/null
[[ -e $state/boxes/p1 ]] || fail "keep off did not restart the idle clock"
"$exebox" keep p1 2x 2>/dev/null && fail "bad duration accepted"

"$exebox" ls | grep -q "^p1 " || fail "ls misses p1"
"$exebox" rm p1 </dev/null 2>/dev/null && fail "rm without --yes"
pvm=$(vm_of p1)
"$exebox" rm p1 --yes
[[ ! -e $FAKE_EXE/vms/$pvm && ! -e $state/boxes/p1 ]] || fail "rm left the VM or state"
echo "exebox: all tests passed"

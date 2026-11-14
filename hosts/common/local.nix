# Per-machine additions that never reach git. Committed as two empty modules:
# lib/ imports `nixos` into every NixOS host and `darwin` into every Darwin
# host. To use it on one machine, run once:
#
#   git update-index --skip-worktree hosts/common/local.nix
#
# then edit the file there. Git keeps treating it as this stub (no diff, never
# staged or committed), while Nix reads the working tree, so a plain
# `nixos-rebuild`/`darwin-rebuild --flake .#<host>` picks the edits up. A fresh
# clone starts from the stub again. If a pull ever changes this stub, git
# refuses it: move the edits aside, `--no-skip-worktree`, pull, and redo.
{
  nixos = { };
  darwin = { };
}

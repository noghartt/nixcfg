#!/bin/sh
set -eu

# Plugin processes do not necessarily inherit an interactive Nix shell's PATH.
export PATH="$HOME/.nix-profile/bin:/etc/profiles/per-user/$(id -un)/bin:/run/current-system/sw/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
exec python3 "${HERDR_PLUGIN_ROOT:?}/pr_tree.py"

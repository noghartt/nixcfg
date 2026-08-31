# PLACEHOLDER so the flake evaluates before installation.
# Replace with the output of `nixos-generate-config` on the real machine
# (see TASK.md). Do not hand-edit after that point. Filesystems and swap
# come from disko (disk.nix), so nothing of that belongs here.
{ lib, ... }:
{
  nixpkgs.hostPlatform = lib.mkDefault "x86_64-linux";
}

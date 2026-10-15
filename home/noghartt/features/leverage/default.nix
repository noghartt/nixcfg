# Leverage Computer CLI, pinned in Nix instead of upstream's ~/.local/bin
# installer. Logins, workspace choice and options stay writable runtime state
# under ~/.config/leverage.
{ pkgs, ... }:
{
  home.packages = [ (pkgs.callPackage ./package.nix { }) ];
}

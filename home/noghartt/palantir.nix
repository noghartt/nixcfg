# Palantir shares portable application configuration with Mellon; only the
# Ghostty package differs because Darwin uses the prebuilt package.
{ pkgs, ... }:
{
  imports = [
    ./features/desktop/chrome.nix
    ./features/desktop/firefox.nix
    ./features/desktop/ghostty.nix
    ./features/desktop/obsidian.nix
    ./features/vscode
  ];

  programs.ghostty.package = pkgs.ghostty-bin;

  # Cherry-picked from the desktop applications bundle; the rest of it is
  # either cask-managed here (slack) or not wanted on the work laptop.
  home.packages = [ pkgs.spotify ];

  # The tailscale-app cask links no CLI onto PATH; the bundled binary is the
  # supported way to get one (nixpkgs' tailscale ships a conflicting daemon
  # and would drift from the self-updating app).
  home.shellAliases.tailscale = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
}

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
}

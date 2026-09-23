# Palantir uses the prebuilt Ghostty package and launches Herdr directly.
{
  config,
  lib,
  pkgs,
  ...
}:
{
  imports = [
    ./features/desktop/chrome.nix
    ./features/desktop/firefox.nix
    ./features/desktop/ghostty.nix
    ./features/desktop/obsidian.nix
    ./features/vscode
  ];

  home.packages = with pkgs; [
    beancount
    cloudflared
    fava
    todoist
  ];

  programs.ghostty = {
    package = pkgs.ghostty-bin;
    settings.command = lib.getExe config.programs.herdr.package;
  };

  # The tailscale-app cask links no CLI onto PATH; the bundled binary is the
  # supported way to get one (nixpkgs' tailscale ships a conflicting daemon
  # and would drift from the self-updating app).
  home.shellAliases.tailscale = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
}

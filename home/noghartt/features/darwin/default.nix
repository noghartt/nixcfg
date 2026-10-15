# Home side shared by the MacBooks (palantir, mithril): both use the prebuilt
# Ghostty package, launch Herdr directly, and run the same agent stack.
{
  config,
  lib,
  pkgs,
  ...
}:
{
  imports = [
    ../cua
    ../desktop/chrome.nix
    ../desktop/firefox.nix
    ../desktop/ghostty.nix
    ../desktop/obsidian.nix
    ../omo
    ../swarm
    ../vscode
  ];

  home = {
    packages = with pkgs; [
      beancount
      cloudflared
      fava
      fswatch
      todoist
    ];

    # The tailscale-app cask links no CLI onto PATH; the bundled binary is the
    # supported way to get one (nixpkgs' tailscale ships a conflicting daemon
    # and would drift from the self-updating app).
    shellAliases.tailscale = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

    # sbx reports every CLI invocation; swarms call it constantly.
    sessionVariables.SBX_NO_TELEMETRY = 1;
  };

  programs.ghostty = {
    package = pkgs.ghostty-bin;
    settings.command = lib.getExe config.programs.herdr.package;
  };
}

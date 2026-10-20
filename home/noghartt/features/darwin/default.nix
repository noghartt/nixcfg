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

    # The Rex terminal (a .dmg, self-updating) keeps its `rex` CLI in the server
    # bundle it unpacks per account and links nothing onto PATH. Rex prepends that
    # dir when it spawns a shell, but nix-darwin's set-environment rebuilds PATH
    # from scratch, so it is added here; agent hooks from `rex skill setup` call
    # `rex` too. `Versions/Current` follows updates.
    sessionPath = [
      "$HOME/Library/Application Support/com.superlogical.rex/RexServer/Versions/Current/Rex Server.app/Contents/MacOS"
    ];

    # sbx reports every CLI invocation; swarms call it constantly.
    sessionVariables.SBX_NO_TELEMETRY = 1;
  };

  programs.ghostty = {
    package = pkgs.ghostty-bin;
    settings.command = lib.getExe config.programs.herdr.package;
  };
}

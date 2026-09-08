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

  home.packages = with pkgs; [
    beancount
    cloudflared
    fava
  ];

  programs.ghostty.package = pkgs.ghostty-bin;

  # The tailscale-app cask links no CLI onto PATH; the bundled binary is the
  # supported way to get one (nixpkgs' tailscale ships a conflicting daemon
  # and would drift from the self-updating app).
  home.shellAliases.tailscale = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";
}

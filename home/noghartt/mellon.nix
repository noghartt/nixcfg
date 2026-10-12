# Mellon's portable desktop plus Linux/Wayland integrations; Ghostty launches Herdr directly.
{
  config,
  lib,
  pkgs,
  ...
}:
{
  imports = [
    ./features/cli/ssh-server.nix
    ./features/desktop
    ./features/desktop/hyprland.nix
    ./features/desktop/hyprsunset.nix
    ./features/desktop/noctalia.nix
    ./features/omo
  ];

  home.packages = with pkgs; [
    # Clipboard backend for Herdr's copy actions on Wayland.
    wl-clipboard
    # Per-app volume and device routing for the PipeWire stack.
    pavucontrol
    calibre
    todoist-electron
  ];

  programs.ghostty = {
    package = pkgs.ghostty;
    settings.command = lib.getExe config.programs.herdr.package;
  };

  services.flameshot.settings.General.disabledTrayIcon = true;

  xdg.mimeApps = {
    enable = true;
    defaultApplications = {
      "application/xhtml+xml" = [ "firefox.desktop" ];
      "text/html" = [ "firefox.desktop" ];
      "x-scheme-handler/http" = [ "firefox.desktop" ];
      "x-scheme-handler/https" = [ "firefox.desktop" ];
      "x-scheme-handler/slack" = [ "slack.desktop" ];
      "x-scheme-handler/todoist" = [ "todoist.desktop" ];
    };
  };
}

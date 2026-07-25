# Mellon's portable desktop plus Linux/Wayland integrations.
{ lib, pkgs, ... }:
{
  imports = [
    ./features/desktop
    ./features/desktop/hyprland.nix
    ./features/desktop/hyprsunset.nix
    ./features/desktop/noctalia.nix
    ./features/desktop/rofi.nix
  ];

  home.packages = with pkgs; [
    calibre
    todoist-electron
  ];

  programs.ghostty.package = pkgs.ghostty;

  services.flameshot.settings.General.disabledTrayIcon = true;

  programs.tmux.extraConfig = lib.mkAfter ''
    # Copy selections directly to the Wayland clipboard.
    bind-key -T copy-mode-vi MouseDragEnd1Pane send-keys -X copy-pipe-and-cancel "${lib.getExe' pkgs.wl-clipboard "wl-copy"}"
    bind-key -T copy-mode-vi y send-keys -X copy-pipe-and-cancel "${lib.getExe' pkgs.wl-clipboard "wl-copy"}"
  '';

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

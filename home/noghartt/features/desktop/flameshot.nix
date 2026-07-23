# Screenshots on Wayland go through xdg-desktop-portal (already wired by
# programs.hyprland on the system side).
{
  services.flameshot = {
    enable = true;
    settings.General = {
      disabledTrayIcon = true;
      showStartupLaunchMessage = false;
    };
  };
}

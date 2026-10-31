# On Wayland, screenshots go through the GNOME portal wired by programs.niri.
{
  services.flameshot = {
    enable = true;
    settings.General.showStartupLaunchMessage = false;
  };
}

# On Wayland, screenshots go through the portal wired by Hyprland.
{
  services.flameshot = {
    enable = true;
    settings.General.showStartupLaunchMessage = false;
  };
}

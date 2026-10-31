# Night light through wlr-gamma-control, which Niri implements (hyprsunset
# needs Hyprland's own CTM protocol).
{
  services.wlsunset = {
    enable = true;

    # Fixed local times avoid storing coordinates or relying on GeoClue.
    sunrise = "07:30";
    sunset = "19:00";
    temperature.night = 4000;
  };
}

{
  services.hyprsunset = {
    enable = true;

    # Fixed local times avoid storing coordinates or relying on GeoClue.
    settings.profile = [
      {
        time = "07:30";
        identity = true;
      }
      {
        time = "19:00";
        temperature = 4000;
      }
    ];
  };
}

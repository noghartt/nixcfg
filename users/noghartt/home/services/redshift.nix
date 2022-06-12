{
  services.redshift = {
    enable = true;

    settings = {
      redshift = {
        brightness-day = "1";
        brightness-night = "0.8";
      };
    };

    temperature = {
      day = 5500;
      night = 3700;
    };

    latitude = "-23.5513981";
    longitude = "-46.6335635";
  };
}

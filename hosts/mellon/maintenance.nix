{
  services = {
    smartd = {
      enable = true;
      autodetect = true;
      notifications.systembus-notify.enable = true;
    };

    fstrim = {
      enable = true;
      interval = "weekly";
    };

    power-profiles-daemon.enable = true;
  };
}

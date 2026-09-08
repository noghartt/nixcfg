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

    snapper = {
      snapshotInterval = "hourly";
      cleanupInterval = "1d";
      persistentTimer = true;

      configs.root = {
        SUBVOLUME = "/";
        TIMELINE_CREATE = true;
        TIMELINE_CLEANUP = true;
        TIMELINE_LIMIT_HOURLY = 24;
        TIMELINE_LIMIT_DAILY = 7;
        TIMELINE_LIMIT_WEEKLY = 4;
        TIMELINE_LIMIT_MONTHLY = 12;
        TIMELINE_LIMIT_YEARLY = 2;
      };
    };

    journald.settings.Journal = {
      SystemMaxUse = "2G";
      MaxRetentionSec = "1month";
    };
  };
}

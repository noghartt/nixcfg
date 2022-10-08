{ pkgs, ... }:

{
  services.screen-locker = {
    enable = true;
    lockCmd = "${pkgs.slock}/bin/slock";

    xautolock = {
      enable = true;
    };
  };

  # systemd.services.lock-before-sleeping = {
  #   restartIfChanged = false;

  #   unitConfig = {
  #     Description = "Helper service to bind locker to sleep.target";
  #   };

  #   serviceConfig = {
  #     ExecStart = "${pkgs.slock}/bin/slock";
  #     Type = "simple";
  #   };

  #   before = [ "pre-sleep.service" ];
  #   wantedBy = [ "pre-sleep.service" ];

  #   environment = {
  #     DISPLAY = ":0";
  #     XAUTHORITY = "/home/noghartt/.Xauthority";
  #   };
  # };
}

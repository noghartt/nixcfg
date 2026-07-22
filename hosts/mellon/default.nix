# Host spec for mellon, consumed by lib.mkNixOSConfig — NOT a plain NixOS
# module. Fields beyond a normal module's:
#   users   user factories from the `users` argument: bare for defaults,
#           called (name { ... }) to replace fields, or
#           name.overrideAttrs (old: { ... }) to extend the defaults.
#   imports inner modules, appended with the resolved users.
# Everything else passes through as NixOS config.
{ users, ... }:

{
  imports = [
    ./hardware-configuration.nix
    ./nvidia.nix
    ../common/global
  ];

  users = with users; [ noghartt ];

  device.type = "desktop";

  boot.loader = {
    systemd-boot = {
      enable = true;
      configurationLimit = 20;
    };
    efi.canTouchEfiVariables = true;
  };

  networking.networkmanager.enable = true;

  # time.timeZone = "America/Sao_Paulo";

  system.stateVersion = "26.11";
}

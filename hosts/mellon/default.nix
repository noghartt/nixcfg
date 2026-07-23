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
    ./hardware.nix
    ./disk.nix
    ./boot.nix
    ./nvidia.nix
    ./desktop.nix
    ./1password.nix
    ../common/global
  ];

  users = with users; [ noghartt ];

  device.type = "desktop";

  networking.networkmanager.enable = true;

  time.timeZone = "America/Sao_Paulo";

  system.stateVersion = "26.11";
}

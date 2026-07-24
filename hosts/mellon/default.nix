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
    ./networking.nix
    ./maintenance.nix
    ./1password.nix
    ./docker.nix
    ../common/global
  ];

  # Host services extend the user's portable groups.
  users = [
    (users.noghartt.overrideAttrs (old: {
      extraGroups = old.extraGroups ++ [
        "docker"
        "wireshark"
      ];
    }))
  ];

  device.type = "desktop";

  i18n.defaultLocale = "en_US.UTF-8";
  console.keyMap = "us";
  time.timeZone = "America/Sao_Paulo";

  system.stateVersion = "26.11";
}

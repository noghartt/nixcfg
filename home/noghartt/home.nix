# Portable home-manager baseline for this user, imported on every host.
# Desktop and platform composition lives in <host>.nix next to this file.
{ config, ... }:
{
  imports = [
    ../../config/neovim
    ./features/cli
    ./features/pi
  ];

  home.sessionVariables.NIXCFG = "${config.home.homeDirectory}/www/nixcfg";

  programs.home-manager.enable = true;
}

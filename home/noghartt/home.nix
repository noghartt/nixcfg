# Portable home-manager baseline for this user, imported on every host.
# Desktop and platform composition lives in <host>.nix next to this file.
{ config, ... }:
{
  imports = [
    ../../config/neovim
    ./features/agent-evals
    ./features/cli
    ./features/hashcards
    ./features/herdr
    ./features/pi
    ./features/sandbox
  ];

  home.sessionVariables.NIXCFG = "${config.home.homeDirectory}/www/nixcfg";

  programs.home-manager.enable = true;
}

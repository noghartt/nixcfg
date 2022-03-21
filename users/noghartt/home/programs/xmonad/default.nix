{ config, lib, pkgs, ... }:

{
  services.xserver = {
    enable = true;

    displayManager = {
      defaultSession = "none+xmonad";
      startx.enable = true;
    };

    windowManager.xmonad = {
      enable = true;
      enableContribAndExtras = true;
      extraPackages = haskellPackages: with haskellPackages; [
        xmonad
        xmonad-contrib
        xmonad-extras
        xmobar
      ];
    };
  };
}

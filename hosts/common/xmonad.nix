{ config, lib, pkgs, ... }:

{
  services.xserver.enable = true;

  services.xserver.displayManager = {
    # TODO: I don't know if it's correctly to use in this way.
    defaultSession = "none+xmonad";
    startx.enable = true;
  };

  services.xserver.windowManager.xmonad = {
    enable = true;
    enableContribAndExtras = true;
    extraPackages = haskellPackages: with haskellPackages; [
      xmonad
      xmonad-contrib
      xmonad-extras
      xmobar
    ];
  };
}

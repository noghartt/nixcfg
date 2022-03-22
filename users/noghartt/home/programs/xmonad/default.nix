{ ... }:

{
  xsession = {
    enable = true;

    windowManager.xmonad = {
      enable = true;
      enableContribAndExtras = true;
      config = ./xmonad.hs;
      extraPackages = haskellPackages: with haskellPackages; [
        xmonad
        xmonad-contrib
        xmonad-extras
        xmobar
      ];
    };
  };
}

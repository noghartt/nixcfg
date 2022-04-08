{ pkgs }:

{
  xsession = {
    enable = true;

    windowManager.xmonad = {
      enable = true;
      enableContribAndExtras = true;

      config = ./xmonad.hs;

      extraPackages = haskellPackages: with haskellPackages; [
        xmonad_0_17_0
        xmonad-contrib_0_17_0
        xmonad-extras_0_17_0
      ];
    };
  };

  home.packages = with pkgs; [ dmenu ];
}

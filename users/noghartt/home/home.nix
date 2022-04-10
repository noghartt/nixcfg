{ inputs, pkgs, ... }:

{
  imports = [
    inputs.doom-emacs.hmModule

    ./programs/xmonad
    ./programs/git.nix
    ./programs/alacritty.nix
    ./programs/firefox.nix
  ];

  home.packages = with pkgs;  [
    discord
    neofetch
  ];
}

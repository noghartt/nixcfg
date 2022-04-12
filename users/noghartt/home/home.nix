{ inputs, pkgs, ... }:

{
  imports = [
    inputs.doom-emacs.hmModule

    ./programs/xmonad
    ./programs/git.nix
    ./programs/alacritty.nix
    ./programs/firefox.nix
    ./programs/emacs.nix
    ./programs/qutebrowser.nix
    ./programs/fish.nix
    ./programs/redshift.nix
  ];

  home.packages = with pkgs;  [
    pavucontrol
    discord
    neofetch
  ];
}

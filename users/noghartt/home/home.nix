{ inputs, pkgs, ... }:

{
  imports = [
    inputs.doom-emacs.hmModule

    ./programs/git.nix
    ./programs/firefox.nix
  ];

  home.packages = with pkgs;  [
    discord
    neofetch
  ];
}

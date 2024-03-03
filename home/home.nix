{ pkgs, ... }:

{
  home.stateVersion = "23.11";

  imports = [
    ./zsh.nix
  ];

  home.packages = with pkgs; [
    htop
    curl
    coreutils
    jq
  ];
}

{ pkgs, ... }:

{
  home.stateVersion = "23.11";

  home.packages = with pkgs; [
    htop
    curl
    coreutils
    jq
  ];
}

{ pkgs, username, ... }:

{
  programs.doom-emacs = {
    enable = true;
    doomPrivateDir = ./doom.d;
    emacsPackage = pkgs.emacsUnstable;
  };

  home.packages = with pkgs; [
    fd
    ripgrep
    clang
    coreutils

    texlive.combined.scheme-medium
  ];

  services.emacs = { enable = true; };
}

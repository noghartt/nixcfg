{ pkgs, ... }:
let
  # FFF includes xdotool only for X11 image previews; nixpkgs wires it
  # unconditionally even though the rest of FFF works on Darwin.
  fff = pkgs.fff.override {
    xdotool = if pkgs.stdenv.hostPlatform.isDarwin then pkgs.emptyDirectory else pkgs.xdotool;
  };
in
{
  home.packages = [
    fff
    pkgs.ngrok
  ];

  programs = {
    # eza is the maintained drop-in fork of exa; the zsh integration wires
    # the ls/ll/la/lt aliases itself.
    eza = {
      enable = true;
      enableZshIntegration = true;
      icons = "auto";
    };

    bat.enable = true;
    fd.enable = true;

    fzf = {
      enable = true;
      enableZshIntegration = true;
    };

    lazygit.enable = true;
  };
}

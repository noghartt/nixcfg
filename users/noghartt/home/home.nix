{ config, pkgs, ... }:

{
  imports = [
    ./programs/xmonad
    ./programs/xmonad/xmobar.nix
    ./programs/git.nix
    ./programs/firefox.nix
    ./programs/emacs
    ./programs/qutebrowser.nix
    ./programs/vscode.nix

    ./terminal/alacritty.nix
    ./terminal/fish
    ./terminal/tmux
    ./terminal/direnv.nix

    ./services/redshift.nix
    ./services/slock.nix
  ];

  home.packages = with pkgs;  [
    pavucontrol
    discord
    neofetch
    google-chrome
    gh
    nyxt
    steam
    xfce.thunar
    flameshot
    docker
    docker-compose
    robo3t
    gimp
    peek
  ];

  home.file."homecfg" = {
    target = ".config/nixpkgs";
    source = config.lib.file.mkOutOfStoreSymlink "/dotfiles";
  };
}

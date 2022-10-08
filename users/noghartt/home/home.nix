{ config, pkgs, ... }:

{
  home.stateVersion = "22.05";

  imports = [
    # ./programs/xmonad
    # ./programs/xmonad/xmobar.nix
    ./i3.nix
    ./java.nix

    ./programs/git.nix
    ./programs/firefox.nix
    ./programs/emacs
    ./programs/qutebrowser.nix
    ./programs/vscode.nix

    ./terminal/alacritty.nix
    ./terminal/fish
    ./terminal/tmux
    ./terminal/direnv.nix
    ./terminal/gh.nix

    ./services/redshift.nix
    ./services/slock.nix
    ./services/gpg.nix
  ];

  home.packages = with pkgs;  [
    pavucontrol
    discord
    neofetch
    google-chrome
    nyxt
    steam
    xfce.thunar
    flameshot
    docker
    docker-compose
    robo3t
    gimp
    peek
    android-studio
    
    htop
    manga-cli
    gh-stars
    go
  
    pandoc
  ];

  home.file."homecfg" = {
    target = ".config/nixpkgs";
    source = config.lib.file.mkOutOfStoreSymlink "/dotfiles";
  };

  home.sessionVariables = {
    EDITOR = "vim";
  };
}

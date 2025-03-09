{ pkgs, ... }:

{
  home.stateVersion = "25.05";

  home.packages = with pkgs; [
    htop
    curl
    coreutils
    jq
    monaspace
    fava
    python3Packages.beancount
    python3Packages.bean-price
    zotero
    calibre
    net-news-wire
    yubico-pam
    yubikey-manager
    ripgrep
    fd
    age
    ngrok
    python311Packages.uv
    nodejs_22
  ];

  imports = [
    ./vscode.nix
    ./git.nix
    ./zsh.nix
    ./fish.nix
    ./ssh.nix
    ./nvim.nix
    ./tmux.nix
  ];

  programs.dircolors = {
    enable = true;
    enableZshIntegration = true;
  };

  programs.direnv.enable = true;
}

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
    # nodePackages."@github/copilot-language-server"
    copilot-language-server
    bore-cli
    emacs

    nerd-fonts.hack
    iosevka
    nixd
  ];

  imports = [
    ./vscode.nix
    ./git.nix
    ./zsh.nix
    ./fish.nix
    ./ssh.nix
    ./nvim.nix
    ./tmux.nix
    ./aerospace.nix
    ./ghostty.nix
    ./sketchybar.nix
  ];

  programs.dircolors = {
    enable = true;
    enableZshIntegration = true;
  };

  programs.direnv.enable = true;

  xdg.configFile.emacs = {
    source = ../../emacs;
    recursive = true;
  };
}

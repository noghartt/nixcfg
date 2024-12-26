{ pkgs, config, lib, ... }:
 
{
  home.stateVersion = "25.05";
 
  home.packages = with pkgs; [
    htop
    curl
    coreutils
    jq
    monaspace
  ];

  imports = [
    ./vscode.nix
    ./git.nix
    ./zsh.nix
  ];

  programs.tmux = {
    enable = true;
  };
 
  programs.dircolors = {
    enable = true;
    enableZshIntegration = true;
  };

  programs.direnv.enable = true;
}

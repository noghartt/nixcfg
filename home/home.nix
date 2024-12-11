{ pkgs, ... }:
 
{
  home.stateVersion = "25.05";
 
  home.packages = with pkgs; [
    htop
    curl
    coreutils
    jq
    nodejs_23
  ];

  programs.tmux = {
    enable = true;
  };
 
  programs.dircolors = {
    enable = true;
    enableZshIntegration = true;
  };

  programs.zsh = {
    enable = true;

    initExtra = ''
      # Startup ZSH with Tmux
      if command -v tmux &> /dev/null && [ -z "$TMUX" ]; then
        tmux attach-session -t default || tmux new-session -s default
      fi
    '';

    syntaxHighlighting.enable = true;
    autosuggestion.enable = true;

    oh-my-zsh = {
      enable = true;

      theme = "robbyrussell";

      plugins = ["git" "sudo" "docker" "kubectl"];
    };
  };
}

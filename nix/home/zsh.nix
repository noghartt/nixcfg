_:

{
  programs.zsh = {
    enable = true;

    initExtra = ''
      # Startup ZSH with Tmux
      if command -v tmux &> /dev/null && [ -z "$TMUX" ]; then
        tmux attach-session -t default || tmux new-session -s default
      fi

      if [ -e "$HOME/.env" ]; then
        source "$HOME/.env"
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

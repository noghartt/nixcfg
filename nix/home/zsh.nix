_:

{
  programs.zsh = {
    enable = false;

    initExtra = ''
      if [ -e "$HOME/.env" ]; then
        source "$HOME/.env"
      fi
    '';

    syntaxHighlighting.enable = true;
    autosuggestion.enable = true;

    oh-my-zsh = {
      enable = true;

      theme = "robbyrussell";

      plugins = ["git" "sudo" "docker" "kubectl" "tmux"];
    };
  };
}

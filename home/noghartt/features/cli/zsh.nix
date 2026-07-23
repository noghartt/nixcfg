{
  programs.zsh = {
    enable = true;
    autosuggestion.enable = true;
    syntaxHighlighting.enable = true;

    # bat detects non-tty output and degrades to plain cat, so the alias
    # is safe for pipelines.
    shellAliases = {
      cat = "bat";
    };
  };
}

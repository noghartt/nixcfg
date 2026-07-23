{
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

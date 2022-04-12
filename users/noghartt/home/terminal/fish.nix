{
  programs.fish = {
    enable = true;

    shellInit = ''
      set -gx GPG_TTY (tty)
    '';
  };
}

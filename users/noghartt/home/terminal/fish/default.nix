{
  programs.fish = {
    enable = true;

    shellInit = ''
      set -gx GPG_TTY (tty)
    '';

    functions = {
      fish_prompt = builtins.readFile ./functions/fish_prompt.fish;
    };
  };
}

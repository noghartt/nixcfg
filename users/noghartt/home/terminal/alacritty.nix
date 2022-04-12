{ pkgs, ... }:

{
  programs.alacritty = {
    enable = true;

    settings = {
      shell.program = "${pkgs.tmux}/bin/tmux";

      window = {
        padding = {
          x = 5;
          y = 5;
        };
      };
    };
  };
}

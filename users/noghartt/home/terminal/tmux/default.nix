{ pkgs, ... }:

let
  plugins = pkgs.tmuxPlugins;
in
{
  programs.tmux = {
    enable = true;

    terminal = "screen-256color";
    shell = "${pkgs.fish}/bin/fish";

    plugins = with plugins; [
      cpu
    ];
  };
}

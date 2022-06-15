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

    newSession = true;
    disableConfirmationPrompt = true;
    prefix = "C-Space";
    historyLimit = 5000;

    extraConfig = builtins.readFile ./tmux.conf;
  };
}

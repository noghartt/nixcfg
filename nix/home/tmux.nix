{ pkgs, ... }:

{
  programs.tmux = {
    enable = true;

    shell = "${pkgs.fish}/bin/fish";
    mouse = true;
    terminal = "screen-256color";
    historyLimit = 50000;
    keyMode = "vi";

    tmuxinator.enable = true;

    plugins = with pkgs; [
      tmuxPlugins.better-mouse-mode
    ];
  };
}

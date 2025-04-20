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

    extraConfig = ''
      bind -n C-h select-pane -L
      bind -n C-j select-pane -D
      bind -n C-k select-pane -U
      bind -n C-l select-pane -R
    '';
  };
}

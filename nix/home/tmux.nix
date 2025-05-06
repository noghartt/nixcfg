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
      set -g status-style 'bg=black fg=white'
      set -g pane-border-style 'fg=black'
      set -g pane-active-border-style 'fg=red'

      bind c new-wind -c '#{pane_current_path}'
      bind '"' split-window -c '#{pane_current_path}'
      bind % split-window -h -c '#{pane_current_path}'

      bind -n C-h select-pane -L
      bind -n C-j select-pane -D
      bind -n C-k select-pane -U
      bind -n C-l select-pane -R
    '';
  };
}

{
  programs.tmux = {
    enable = true;
    mouse = true;
    baseIndex = 1;
    terminal = "tmux-256color";

    extraConfig = ''
      set -ag terminal-overrides ",xterm-256color:RGB"
      set -g renumber-windows on
      set -g extended-keys-format csi-u

      # Splits open in the current directory
      bind '"' split-window -v -c "#{pane_current_path}"
      bind % split-window -h -c "#{pane_current_path}"

      # Status bar (catppuccin-mocha palette)
      set -g status-position bottom
      set -g status-interval 5
      set -g status-justify left
      set -g status-style "bg=#1e1e2e,fg=#cdd6f4"

      set -g status-left-length 30
      set -g status-left "#[bg=#89b4fa,fg=#1e1e2e,bold]  #S #[bg=#1e1e2e,fg=#89b4fa]"

      set -g status-right-length 50
      set -g status-right "#[fg=#6c7086]│ #[fg=#cdd6f4]%H:%M #[fg=#6c7086]│ #[fg=#a6adc8]%d %b %Y "

      setw -g window-status-format "#[fg=#6c7086] #I#[fg=#585b70]:#[fg=#a6adc8]#W#{?window_flags,#{window_flags}, } "
      setw -g window-status-current-format "#[bg=#313244,fg=#89b4fa,bold] #I#[fg=#585b70]:#[fg=#cdd6f4]#W#{?window_flags,#{window_flags}, } #[bg=#1e1e2e]"
      setw -g window-status-separator ""

      set -g pane-border-style "fg=#313244"
      set -g pane-active-border-style "fg=#89b4fa"

      set -g message-style "bg=#313244,fg=#cdd6f4"
      set -g message-command-style "bg=#313244,fg=#cdd6f4"

      set -g allow-passthrough on
      set -s extended-keys on
      set -as terminal-features 'xterm*:extkeys'

      bind Escape copy-mode
    '';
  };
}

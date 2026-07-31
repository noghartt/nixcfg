{
  config,
  lib,
  pkgs,
  ...
}:
let
  tmuxGitRootPath = pkgs.writeShellApplication {
    name = "tmux-git-root-path";
    runtimeInputs = [ pkgs.git ];
    text = ''
      dir="''${1:-.}"
      cd "$dir" && git rev-parse --show-toplevel 2>/dev/null || echo "$dir"
    '';
  };

  tmuxAttach = pkgs.writeShellApplication {
    name = "tmux-attach";
    bashOptions = [ ];
    runtimeInputs = [ pkgs.tmux ];
    text = ''
      session=$(tmux list-sessions -F '#{session_name}' 2>/dev/null | head -1)
      if [ -z "$session" ]; then
        exec tmux new-session -s main
      fi
      exec tmux attach-session -t "$session"
    '';
  };
in
{
  home.packages = [
    tmuxAttach
    tmuxGitRootPath
  ];

  programs.ghostty.settings = lib.mkIf config.programs.ghostty.enable {
    command = lib.getExe tmuxAttach;
  };

  programs.tmux = {
    enable = true;
    shell = "/bin/sh";
    prefix = "C-space";
    keyMode = "vi";
    mouse = true;
    baseIndex = 1;
    historyLimit = 50000;
    sensibleOnTop = false;
    terminal = "tmux-256color";

    extraConfig = ''
      # Keep tmux jobs fast while interactive panes still launch the user shell.
      set -g default-command "${pkgs.zsh}/bin/zsh -l"

      set -ag terminal-overrides ",xterm-256color:RGB"
      set -g renumber-windows on
      set -g escape-time 1
      set -g display-time 4000
      set -g focus-events on
      setw -g aggressive-resize on
      set -g extended-keys-format csi-u

      bind-key R source-file ~/.config/tmux/tmux.conf \; display-message "Config reloaded"

      # Agent tools and new windows open at the nearest git root.
      bind-key o run-shell 'tmux split-window -h -c "$(${lib.getExe tmuxGitRootPath} "#{pane_current_path}")" opencode'
      bind-key l run-shell 'tmux split-window -h -c "$(${lib.getExe tmuxGitRootPath} "#{pane_current_path}")" lazygit'
      bind-key c run-shell 'tmux new-window -c "$(${lib.getExe tmuxGitRootPath} "#{pane_current_path}")"'
      bind-key C new-window -c "#{pane_current_path}"

      # Splits inherit the current pane's directory.
      bind '"' split-window -v -c "#{pane_current_path}"
      bind % split-window -h -c "#{pane_current_path}"
      bind-key s choose-tree -sZO name

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

    plugins = with pkgs.tmuxPlugins; [
      better-mouse-mode
      {
        plugin = resurrect;
        extraConfig = ''
          set -g @resurrect-capture-pane-contents 'on'
          set -g @resurrect-strategy-nvim 'session'
          set -g @resurrect-restore-cwd 'on'
        '';
      }
      {
        plugin = continuum;
        extraConfig = ''
          set -g @continuum-restore 'on'
          set -g @continuum-save-interval '10'
        '';
      }
    ];
  };
}

{
  config,
  lib,
  pkgs,
  ...
}:
let
  pi = lib.getExe config.programs.pi-coding-agent.package;
  piSessionSearch = pkgs.writeShellApplication {
    name = "pi-session-search";
    runtimeInputs = with pkgs; [
      coreutils
      findutils
      fzf
      git
      jq
      tmux
    ];
    text = builtins.replaceStrings [ "@PI@" ] [ pi ] (builtins.readFile ./scripts/session-search.sh);
  };

  piTmuxOpen = pkgs.writeShellApplication {
    name = "pi-tmux-open";
    runtimeInputs = with pkgs; [
      git
      tmux
    ];
    text = ''
      dir="''${1:-$PWD}"
      root="$(git -C "$dir" rev-parse --show-toplevel 2>/dev/null || printf '%s' "$dir")"
      exec tmux split-window -h -c "$root" '${pi}'
    '';
  };
in
{
  home.packages = [
    piSessionSearch
    piTmuxOpen
  ];

  programs.tmux.extraConfig = lib.mkIf config.programs.tmux.enable ''
    # Keep Pi work rooted at the checkout while making cross-project history
    # available without squeezing another full TUI into the popup itself.
    bind-key i run-shell '${lib.getExe piTmuxOpen} "#{pane_current_path}"'
    bind-key P display-popup -E -w 85% -h 75% -d "#{pane_current_path}" '${lib.getExe piSessionSearch}'
  '';
}

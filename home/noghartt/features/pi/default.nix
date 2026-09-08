{
  imports = [
    ./settings.nix
    ./tmux.nix
    ./extensions/claude-bridge.nix
    ./extensions/command-palette.nix
    ./extensions/destructive-guard.nix
    ./extensions/pi-workflows.nix
    ./extensions/session-tree.nix
    ./extensions/worktree-agents.nix
  ];

  programs.pi-coding-agent.enable = true;
  home.sessionVariables.PI_OFFLINE = true;
}

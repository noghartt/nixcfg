{
  imports = [
    ./settings.nix
    ./extensions/agent-forum.nix
    ./extensions/command-palette.nix
    ./extensions/destructive-guard.nix
    ./extensions/herdr-fork.nix
    ./extensions/herdr-state.nix
    ./extensions/orchestrator.nix
    ./extensions/pi-workflows.nix
    ./extensions/session-tree.nix
    ./extensions/statusline.nix
    ./extensions/worktree-agents.nix
  ];

  programs.pi-coding-agent = {
    enable = true;
    # features/pi-next installs `pi`; this module only supplies
    # the values OmO inherits.
    package = null;
  };
  home.sessionVariables.PI_OFFLINE = true;
}

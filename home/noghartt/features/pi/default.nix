{ pkgs, agentPath, ... }:
{
  imports = [
    ./settings.nix
    ./extensions/command-palette.nix
    ./extensions/destructive-guard.nix
    ./extensions/herdr-fork.nix
    ./extensions/orchestrator.nix
    ./extensions/pi-workflows.nix
    ./extensions/session-tree.nix
    ./extensions/statusline.nix
    ./extensions/worktree-agents.nix
  ];

  programs.pi-coding-agent = {
    enable = true;
    package = agentPath.wrap pkgs.pi-coding-agent;
  };
  # Experimental durable agent; shares Pi's auth, settings, and keybindings.
  home.packages = [ (agentPath.wrap pkgs.pi-durable) ];
  home.sessionVariables.PI_OFFLINE = true;
}

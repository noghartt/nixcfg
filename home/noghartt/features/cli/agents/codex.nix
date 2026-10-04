{ pkgs, agentPath, ... }:
{
  programs.codex = {
    enable = true;
    package = agentPath.wrap pkgs.codex;
  };
}

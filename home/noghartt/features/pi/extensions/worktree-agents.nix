{ pkgs, ... }:
let
  piWorktreeAgents = pkgs.stdenvNoCC.mkDerivation {
    pname = "pi-worktree-agents";
    version = "1.0.0";
    src = ./worktree-agents;

    installPhase = ''
      runHook preInstall
      cp -r . "$out"
      runHook postInstall
    '';
  };
in
{
  programs.pi-coding-agent.settings.packages = [ piWorktreeAgents ];
}

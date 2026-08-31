{ pkgs, ... }:
let
  piSessionTree = pkgs.stdenvNoCC.mkDerivation {
    pname = "pi-session-tree";
    version = "1.0.0";
    src = ./session-tree;

    installPhase = ''
      runHook preInstall
      cp -r . "$out"
      runHook postInstall
    '';
  };
in
{
  programs.pi-coding-agent.settings.packages = [ piSessionTree ];
}

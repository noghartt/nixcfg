{ lib, pkgs, ... }:
let
  piAgentForum = pkgs.stdenvNoCC.mkDerivation {
    pname = "pi-agent-forum";
    version = "1.0.0";
    src = lib.fileset.toSource {
      root = ./agent-forum;
      fileset = lib.fileset.unions [
        ./agent-forum/package.json
        ./agent-forum/index.ts
        ./agent-forum/client.ts
      ];
    };

    installPhase = ''
      runHook preInstall
      cp -r . "$out"
      runHook postInstall
    '';
  };
in
{
  programs.pi-coding-agent.settings.packages = [ piAgentForum ];
}

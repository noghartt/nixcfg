{ pkgs, ... }:
let
  piDestructiveGuard = pkgs.stdenvNoCC.mkDerivation {
    pname = "pi-destructive-guard";
    version = "1.0.0";
    src = ./destructive-guard;

    installPhase = ''
      runHook preInstall
      cp -r . "$out"
      runHook postInstall
    '';
  };
in
{
  programs.pi-coding-agent.settings.packages = [ piDestructiveGuard ];
}

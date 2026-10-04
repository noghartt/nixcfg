{ pkgs, ... }:
let
  piHerdrFork = pkgs.stdenvNoCC.mkDerivation {
    pname = "pi-herdr-fork";
    version = "1.0.0";
    src = ./herdr-fork;

    installPhase = ''
      runHook preInstall
      cp -r . "$out"
      runHook postInstall
    '';
  };
in
{
  programs.pi-coding-agent.settings.packages = [ piHerdrFork ];
}

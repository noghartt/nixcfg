{ pkgs, ... }:
let
  piCommandPalette = pkgs.stdenvNoCC.mkDerivation {
    pname = "pi-command-palette";
    version = "1.0.0";
    src = ./command-palette;

    installPhase = ''
      runHook preInstall
      cp -r . "$out"
      runHook postInstall
    '';
  };
in
{
  programs.pi-coding-agent.settings.packages = [ piCommandPalette ];
}

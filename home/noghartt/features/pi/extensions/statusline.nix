{ pkgs, ... }:
let
  piStatusline = pkgs.stdenvNoCC.mkDerivation {
    pname = "pi-statusline";
    version = "1.0.0";
    src = ./statusline;

    installPhase = ''
      runHook preInstall
      cp -r . "$out"
      runHook postInstall
    '';
  };
in
{
  programs.pi-coding-agent.settings.packages = [ piStatusline ];
}

# OmO Native: the standalone `omo` command (a pinned senpi/Pi-fork engine with
# the oh-my-openagent extension built in), kept apart from the Pi feature.
{ pkgs, agentPath, ... }:
let
  version = "5.1.13";

  # The release binary is bun-compiled and self-contained; it unpacks its
  # runtime into ~/.omo/binary-runtime/<version>/ on first run. `omo update`
  # only prints a curl line for binary installs, so bumping `version` here is
  # the update path.
  omo-unwrapped = pkgs.stdenvNoCC.mkDerivation {
    pname = "omo";
    inherit version;
    src = pkgs.fetchurl {
      url = "https://github.com/code-yeongyu/oh-my-openagent/releases/download/v${version}/omo-darwin-arm64";
      hash = "sha256-AYecNNwx17ewM4V+ya7jjbTt5/0dRAaO9IY9VBGU3v0=";
    };
    dontUnpack = true;
    # The bun payload is appended to the executable; stripping would drop it.
    dontStrip = true;
    installPhase = ''
      runHook preInstall
      install -Dm755 $src $out/bin/omo
      runHook postInstall
    '';
    meta = {
      platforms = [ "aarch64-darwin" ];
      mainProgram = "omo";
    };
  };

  # The engine falls back to legacy PI_* variables when OMO_* ones are unset;
  # pinning its agent dir keeps it from ever sharing Pi's settings or sessions.
  omo = pkgs.writeShellScriptBin "omo" ''
    ${agentPath.prependPath}
    export OMO_CODING_AGENT_DIR="''${OMO_CODING_AGENT_DIR:-$HOME/.omo/agent}"
    exec -a omo ${omo-unwrapped}/bin/omo "$@"
  '';
in
{
  imports = [
    ./settings.nix
    (import ./config.nix { inherit version; })
  ];

  home.packages = [ omo ];
}

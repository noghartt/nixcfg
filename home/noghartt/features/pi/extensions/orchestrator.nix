{ pkgs, ... }:
let
  piOrchestrator = pkgs.stdenvNoCC.mkDerivation {
    pname = "pi-orchestrator";
    version = "1.0.0";
    src = ./orchestrator;

    installPhase = ''
      runHook preInstall
      cp -r . "$out"
      runHook postInstall
    '';
  };

  inherit (builtins.fromJSON (builtins.readFile ./orchestrator/config.json)) leader;

  # OmO holds the provider logins on Palantir, so it leads when installed; Pi is
  # the portable fallback. Workers re-run whichever harness leads.
  orch = pkgs.writeShellScriptBin "orch" ''
    harness="''${ORCH_HARNESS:-}"
    if [ -z "$harness" ]; then
      if command -v omo >/dev/null 2>&1; then harness=omo; else harness=pi; fi
    fi
    model="''${ORCH_LEADER_MODEL:-${leader.model}}"
    if [ "$#" -gt 0 ]; then
      exec "$harness" --model "$model" "/orchestrate $*"
    fi
    exec "$harness" --model "$model"
  '';
in
{
  programs.pi-coding-agent.settings.packages = [ piOrchestrator ];
  home.packages = [ orch ];
}

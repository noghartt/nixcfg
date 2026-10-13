{ lib, pkgs, ... }:
let
  piOrchestrator = pkgs.stdenvNoCC.mkDerivation {
    pname = "pi-orchestrator";
    version = "1.0.0";
    # Unit tests run from the checkout (`bun test`); the harness never loads them.
    src = lib.cleanSourceWith {
      src = ./orchestrator;
      filter = path: _type: !(lib.hasSuffix ".test.ts" path);
    };

    installPhase = ''
      runHook preInstall
      cp -r . "$out"
      runHook postInstall
    '';
  };

  inherit (builtins.fromJSON (builtins.readFile ./orchestrator/config.json)) leader;

  # OmO holds the provider logins on Palantir, so it leads when installed; Pi is
  # the portable fallback. Workers re-run whichever harness leads. The leader's
  # model list names OmO's subscription provider first and Pi's `anthropic`
  # second; the extension itself takes the first one with credentials.
  orch = pkgs.writeShellScriptBin "orch" ''
    harness="''${ORCH_HARNESS:-}"
    if [ -z "$harness" ]; then
      if command -v omo >/dev/null 2>&1; then harness=omo; else harness=pi; fi
    fi
    if [ "$harness" = omo ]; then
      default=${builtins.elemAt leader.models 0}
    else
      default=${builtins.elemAt leader.models 1}
    fi
    model="''${ORCH_LEADER_MODEL:-$default}"
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

# aeval: session ingest, labelling, reports, model priors (C3) and fine-tuning exports
# over every harness's transcripts. All data stays under $XDG_STATE_HOME/agent-evals;
# only `classify --llm` and `replay` call a model, through a harness's print mode.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  # The pool keys come from the orchestrator's config, so the source keeps the
  # features/ layout that src/pool.ts resolves relative to itself.
  source = lib.fileset.toSource {
    root = ./..;
    fileset = lib.fileset.unions [
      ./src
      ./fixtures
      ../pi/extensions/orchestrator/config.json
    ];
  };

  # The test suite runs at build time: it needs no network and covers every parser,
  # so a broken transcript format fails the build rather than the hourly timer.
  aevalSource = pkgs.stdenvNoCC.mkDerivation {
    pname = "agent-evals";
    version = "0.1.0";
    src = source;
    nativeCheckInputs = [
      pkgs.bun
      pkgs.git
    ];
    dontBuild = true;
    doCheck = true;
    checkPhase = ''
      runHook preCheck
      (cd agent-evals && HOME="$TMPDIR" bun test)
      runHook postCheck
    '';
    installPhase = ''
      runHook preInstall
      mkdir -p "$out"
      cp -r agent-evals pi "$out/"
      rm -rf "$out/agent-evals/fixtures" "$out/agent-evals/src/testutil.ts"
      find "$out" -name '*.test.ts' -delete
      runHook postInstall
    '';
  };

  aeval = pkgs.writeShellApplication {
    name = "aeval";
    runtimeInputs = [
      pkgs.bun
      pkgs.git
    ];
    text = ''exec bun ${aevalSource}/agent-evals/src/cli.ts "$@"'';
  };
in
{
  home.packages = [ aeval ];

  systemd.user = lib.mkIf pkgs.stdenv.hostPlatform.isLinux {
    services.aeval-ingest = {
      Unit.Description = "Import agent session transcripts into aeval";
      Service = {
        Type = "oneshot";
        ExecStart = "${lib.getExe aeval} ingest --quiet";
        Nice = 19;
        IOSchedulingClass = "idle";
      };
    };
    timers.aeval-ingest = {
      Unit.Description = "Hourly aeval ingest";
      Timer = {
        OnCalendar = "hourly";
        Persistent = true;
        RandomizedDelaySec = "5m";
      };
      Install.WantedBy = [ "timers.target" ];
    };
  };

  launchd.agents.aeval-ingest = lib.mkIf pkgs.stdenv.hostPlatform.isDarwin {
    enable = true;
    config = {
      ProgramArguments = [
        (lib.getExe aeval)
        "ingest"
        "--quiet"
      ];
      StartInterval = 3600;
      RunAtLoad = true;
      ProcessType = "Background";
      LowPriorityIO = true;
      Nice = 10;
      StandardErrorPath = "${config.home.homeDirectory}/Library/Logs/aeval-ingest.log";
    };
  };
}

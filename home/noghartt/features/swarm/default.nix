# Agent swarms (SWARM.md): the `swarm` CLI and daemon, the OmO/Pi extension that adds
# `/leader` and `/swarms`, and (Darwin) the Docker Sandboxes kit members run in. On Mellon
# members use agentbox sandboxes instead, so no kit is built there.
{ lib, pkgs, ... }:
let
  # Keep in step with features/omo: pods run the same OmO release as the host.
  omoVersion = "5.1.28";

  omoLinux = pkgs.fetchurl {
    url = "https://github.com/code-yeongyu/oh-my-openagent/releases/download/v${omoVersion}/omo-linux-arm64";
    hash = "sha256-a7ZTAf56k7EGrs0pXDzZRAbGfvl3dOV+E6JMgYFTmSU=";
  };

  packageFiles = lib.fileset.unions [
    ./package.json
    ./config.json
    ./src
    ./extension
  ];

  # Loaded by Pi and OmO (leader side) and copied into the kit (member side).
  swarmPackage = pkgs.stdenvNoCC.mkDerivation {
    pname = "omo-swarm";
    version = "1.0.0";
    src = lib.fileset.toSource {
      root = ./.;
      fileset = packageFiles;
    };
    installPhase = ''
      runHook preInstall
      cp -r . "$out"
      runHook postInstall
    '';
  };

  # The daemon reuses the orchestrator's Jev client, so its source keeps the same
  # relative layout under features/.
  daemonSource = lib.fileset.toSource {
    root = ./..;
    fileset = lib.fileset.unions [
      (lib.fileset.intersection packageFiles ./.)
      ../pi/extensions/orchestrator/jev.ts
    ];
  };

  # A local v3 workload kit: sbx builds it on first use and caches the image. sbx exists only
  # on Darwin, and the kit embeds an arm64 OmO that Linux would download for nothing.
  kit =
    if pkgs.stdenv.hostPlatform.isDarwin then
      pkgs.runCommand "swarm-omo-kit" { } ''
        mkdir -p "$out/swarm"
        cp ${./kit/swarm-omo.yaml} "$out/swarm-omo.yaml"
        cp ${./kit/swarm-omo.dockerfile} "$out/swarm-omo.dockerfile"
        install -m 755 ${omoLinux} "$out/omo"
        cp -r ${swarmPackage}/. "$out/swarm/"
      ''
    else
      null;

  swarm = pkgs.writeShellScriptBin "swarm" ''
    ${lib.optionalString (kit != null) "export SWARM_KIT_DIR=${kit}"}
    exec ${lib.getExe pkgs.bun} ${daemonSource}/swarm/src/cli.ts "$@"
  '';
in
{
  programs.pi-coding-agent.settings.packages = [ swarmPackage ];
  home.packages = [ swarm ];
}

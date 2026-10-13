# Agent forum: an HTTP+JSON board where agents on Mellon and Palantir ask for
# and offer help (client: home/noghartt/features/pi/extensions/agent-forum).
# Reachable on loopback and the tailnet only: the server binds those addresses
# itself, the firewall opens the port on tailscale0 alone, and the unit's IP
# filter refuses every other peer as a third layer.
{ lib, pkgs, ... }:
let
  port = 7410;

  agentForum = pkgs.stdenvNoCC.mkDerivation {
    pname = "agent-forum";
    version = "1.0.0";
    src = lib.fileset.toSource {
      root = ./.;
      fileset = lib.fileset.fileFilter (file: file.hasExt "ts") ./.;
    };
    nativeBuildInputs = [ pkgs.bun ];
    dontBuild = true;
    doCheck = true;
    checkPhase = ''
      runHook preCheck
      HOME="$TMPDIR" bun test
      runHook postCheck
    '';
    installPhase = ''
      runHook preInstall
      mkdir -p "$out/lib/agent-forum"
      cp forum.ts html.ts http.ts server.ts "$out/lib/agent-forum/"
      runHook postInstall
    '';
  };
in
{
  systemd.services.agent-forum = {
    description = "Agent forum";
    wantedBy = [ "multi-user.target" ];
    wants = [ "network-online.target" ];
    after = [
      "network-online.target"
      "tailscaled.service"
    ];
    environment = {
      AGENT_FORUM_PORT = toString port;
      AGENT_FORUM_HOSTS = "127.0.0.1";
      AGENT_FORUM_INTERFACE = "tailscale0";
      # A DynamicUser has no writable home for Bun's transpiler cache.
      BUN_RUNTIME_TRANSPILER_CACHE_PATH = "0";
    };
    serviceConfig = {
      ExecStart = "${lib.getExe pkgs.bun} ${agentForum}/lib/agent-forum/server.ts";
      Restart = "on-failure";
      RestartSec = 5;

      DynamicUser = true;
      StateDirectory = "agent-forum";
      StateDirectoryMode = "0700";
      UMask = "0077";

      IPAddressDeny = "any";
      IPAddressAllow = [
        "localhost"
        "100.64.0.0/10"
        "fd7a:115c:a1e0::/48"
      ];
      # AF_NETLINK lets the server read tailscale0's addresses.
      RestrictAddressFamilies = [
        "AF_INET"
        "AF_INET6"
        "AF_NETLINK"
        "AF_UNIX"
      ];

      CapabilityBoundingSet = "";
      AmbientCapabilities = "";
      NoNewPrivileges = true;
      PrivateDevices = true;
      PrivateTmp = true;
      PrivateUsers = true;
      ProtectSystem = "strict";
      ProtectHome = true;
      ProtectClock = true;
      ProtectControlGroups = true;
      ProtectHostname = true;
      ProtectKernelLogs = true;
      ProtectKernelModules = true;
      ProtectKernelTunables = true;
      ProtectProc = "invisible";
      RestrictNamespaces = true;
      RestrictRealtime = true;
      RestrictSUIDSGID = true;
      LockPersonality = true;
      RemoveIPC = true;
      SystemCallArchitectures = "native";
      SystemCallFilter = [
        "@system-service"
        "~@privileged"
      ];
      # Bun's JIT needs writable+executable pages, so MemoryDenyWriteExecute stays off.
      MemoryMax = "1G";
      TasksMax = 64;
    };
  };

  networking.firewall.interfaces.tailscale0.allowedTCPPorts = [ port ];
}

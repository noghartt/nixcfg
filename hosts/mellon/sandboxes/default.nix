# Agent sandboxes: one systemd-nspawn container per sandbox, booted from a
# writable btrfs snapshot of a Nix-built base image under /agent (disk.nix).
# Isolation: a private user namespace (container root is an unprivileged host
# uid range), its own veth with internet-only egress, no host bind mounts, its
# own Nix store, and per-sandbox cgroup limits. `agentbox` (any member of the
# agentbox group) drives `agentbox-root`, the only privileged entry point,
# through agentbox-rootd on a socket anyone may connect to.
{
  config,
  flake,
  lib,
  pkgs,
  ...
}:
let
  system =
    (flake.inputs.nixpkgs.lib.nixosSystem {
      modules = [
        ./image.nix
        { nixpkgs.hostPlatform = pkgs.stdenv.hostPlatform.system; }
      ];
    }).config.system.build.toplevel;

  # nspawn stops a container with SIGRTMIN+3; stage 2 is sourced rather than
  # exec'd so an early stop signal is not lost (as nixos-container does).
  init = pkgs.writeScript "agentbox-init" ''
    #!${pkgs.runtimeShell}
    trap "exit 0" SIGRTMIN+3
    set +e
    . ${system}/init
  '';

  image = pkgs.runCommand "agentbox-image" { } ''
    mkdir $out
    ln -s ${system} $out/system
    ln -s ${init} $out/init
  '';

  catalog = import ./env-catalog.nix;
  envCatalog = ''
    ENV_DIR=/var/lib/opnix/secrets/agentbox-env
    ENV_NAMES=(${lib.escapeShellArgs (builtins.attrNames catalog)})
    declare -A ENV_VALUES=(${
      lib.concatStrings (
        lib.mapAttrsToList (name: entry: "[${name}]=${lib.escapeShellArg entry.value} ") (
          lib.filterAttrs (_: entry: entry ? value) catalog
        )
      )
    })
  '';

  # Per sandbox, by size class (`agentbox size`); agentbox.slice below caps all
  # of them together. A sandbox also sees only a window of its class's cores
  # (agentbox-root's cpus), so tools that size worker pools by core count stay
  # within its quota and memory.
  sizes = {
    small = {
      cpus = 4;
      memory = "8G";
    };
    medium = {
      cpus = 8;
      memory = "16G";
    };
    large = {
      cpus = 16;
      memory = "32G";
    };
  };
  defaultSize = "medium";
  limits = [
    "MemorySwapMax=4G"
    "TasksMax=4096"
    "IOWeight=50"
  ];
  sizing = ''
    SIZE_NAMES=(${lib.escapeShellArgs (builtins.attrNames sizes)})
    declare -A SIZE_CPUS=(${
      lib.concatStrings (lib.mapAttrsToList (name: size: "[${name}]=${toString size.cpus} ") sizes)
    })
    declare -A SIZE_MEMORY=(${
      lib.concatStrings (lib.mapAttrsToList (name: size: "[${name}]=${size.memory} ") sizes)
    })
    DEFAULT_SIZE=${defaultSize}
  '';

  net = import ./net-sets.nix { inherit lib; };
  profiles = ''
    NET_NAMES=(${lib.escapeShellArgs net.names})
    NET_OPEN=(${lib.escapeShellArgs net.open})
    declare -A NET_SET=(${lib.concatMapStrings (name: "[${name}]=${net.src name} ") net.names})
    DEFAULT_NET=${net.default}
    make_sets() {
    ${net.create}}
  '';

  # Idle means no exec, start or attached process since; `agentbox keep`
  # exempts a sandbox. Removal reclaims its subvolume (and the extents it still
  # shares with superseded bases) after archiving its branches.
  expiry = ''
    STOP_AFTER=12h
    EXPIRE_AFTER=7d
    ARCHIVE_TTL=30d
  '';

  agentbox-root = pkgs.writeShellApplication {
    name = "agentbox-root";
    runtimeInputs = [
      pkgs.btrfs-progs
      pkgs.conntrack-tools
      pkgs.coreutils
      pkgs.gnugrep
      pkgs.ipset
      pkgs.util-linux
      config.nix.package
      config.systemd.package
    ];
    text = ''
      IMAGE=${image}
      LIMITS=(${lib.escapeShellArgs limits})
    ''
    + sizing
    + profiles
    + expiry
    + envCatalog
    + builtins.readFile ./agentbox-root.sh;
  };

  python = pkgs.writers.writePython3Bin;
  rootd = python "agentbox-rootd" { flakeIgnore = [ "E501" ]; } (builtins.readFile ./rootd.py);
  client = python "agentbox-client" { flakeIgnore = [ "E501" ]; } (
    builtins.readFile ./rootd-client.py
  );

  agentbox = pkgs.writeShellApplication {
    name = "agentbox";
    runtimeInputs = [
      pkgs.coreutils
      pkgs.git
    ];
    text = ''
      AGENTBOX_CLIENT=${lib.getExe client}
      NET_NAMES=(${lib.escapeShellArgs net.names})
      DEFAULT_NET=${net.default}
      SIZE_HELP=${
        lib.escapeShellArg (
          lib.concatStringsSep ", " (
            lib.mapAttrsToList (name: size: "${name} (${toString size.cpus} cores, ${size.memory})") sizes
          )
        )
      }
      DEFAULT_SIZE=${defaultSize}
    ''
    + expiry
    + builtins.readFile ./agentbox.sh;
  };

  nspawn = lib.concatStringsSep " " [
    "${config.systemd.package}/bin/systemd-nspawn"
    "--quiet"
    "--keep-unit"
    "--machine=ab-%I"
    "--directory=/agent/sandboxes/%I"
    "--private-users=pick"
    "--private-users-ownership=auto"
    "--private-network"
    "--network-veth"
    "--notify-ready=yes"
    "--kill-signal=SIGRTMIN+3"
    "--link-journal=no"
    "--resolv-conf=off"
    "--timezone=off"
    "--settings=no"
    "/agentbox/init"
  ];
in
{
  imports = [
    ./env.nix
    ./network.nix
  ];

  environment.systemPackages = [ agentbox ];

  # Membership is read from the group database on every request, so it takes
  # effect without a new login.
  users.groups.agentbox = { };

  # One agentbox-rootd per connection: concurrent calls (cloud mode runs one
  # exec per tool call) are independent processes, and a rebuild leaves
  # running ones on their old code instead of cutting them off. Cloud mode
  # also makes these per call, so systemd's per-unit start/stop lines are
  # dropped (LogLevelMax applies to them too); refusals log as warnings.
  systemd.sockets.agentbox-root = {
    description = "agentbox-root requests";
    wantedBy = [ "sockets.target" ];
    listenStreams = [ "/run/agentbox/root.sock" ];
    socketConfig = {
      Accept = true;
      SocketMode = "0666";
      MaxConnections = 512;
    };
  };
  systemd.services."agentbox-root@" = {
    description = "agentbox-root request";
    restartIfChanged = false;
    unitConfig = {
      RequiresMountsFor = "/agent";
      CollectMode = "inactive-or-failed";
    };
    serviceConfig = {
      ExecStart = "${lib.getExe rootd} ${lib.getExe agentbox-root}";
      StandardInput = "socket";
      StandardOutput = "journal";
      StandardError = "journal";
      LogLevelMax = "notice";
    };
  };

  # Kernel sets start empty at boot and when first created; puts every
  # sandbox's subnet back in its profile's set after the firewall (re)starts.
  systemd.services.agentbox-net = {
    description = "Agent sandbox net profiles";
    wantedBy = [ "multi-user.target" ];
    after = [ "firewall.service" ];
    partOf = [ "firewall.service" ];
    unitConfig.RequiresMountsFor = "/agent";
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      ExecStart = "${lib.getExe agentbox-root} net-sync";
    };
  };

  systemd.slices.agentbox = {
    description = "Agent sandboxes";
    sliceConfig = {
      # Throttled and reclaimed before the hard cap kills anything.
      MemoryHigh = "36G";
      MemoryMax = "40G";
      CPUQuota = "2400%";
      # Half the default weight: under contention the desktop and the agents
      # driving the sandboxes stay responsive.
      CPUWeight = 50;
      IOWeight = 50;
      TasksMax = 16384;
    };
  };

  # Rebuilding with a changed image restarts this and lays down a new base;
  # existing sandboxes keep the image they were created from.
  systemd.services.agentbox-base = {
    description = "Agent sandbox base image";
    wantedBy = [ "multi-user.target" ];
    unitConfig.RequiresMountsFor = "/agent";
    serviceConfig = {
      Type = "oneshot";
      RemainAfterExit = true;
      ExecStart = "${lib.getExe agentbox-root} base";
    };
  };

  systemd.services.agentbox-reap = {
    description = "Stop idle agent sandboxes and expire unused ones";
    unitConfig.RequiresMountsFor = "/agent";
    serviceConfig = {
      Type = "oneshot";
      ExecStart = "${lib.getExe agentbox-root} reap";
    };
  };
  systemd.timers.agentbox-reap = {
    wantedBy = [ "timers.target" ];
    timerConfig = {
      OnCalendar = "hourly";
      Persistent = true;
    };
  };

  systemd.services."agentbox@" = {
    description = "Agent sandbox %I";
    # No dependency on agentbox-base: restarting it on a rebuild must not
    # restart running sandboxes, and they only need a base at creation.
    after = [ "network.target" ];
    unitConfig.RequiresMountsFor = "/agent";
    environment.SYSTEMD_NSPAWN_UNIFIED_HIERARCHY = "1";
    serviceConfig = {
      ExecStart = nspawn;
      Type = "notify";
      Slice = "agentbox-%i.slice";
      Delegate = true;
      # nspawn turns SIGTERM into a clean container shutdown.
      KillMode = "mixed";
      KillSignal = "TERM";
      # A reboot inside the container exits 133; restart it like nixos-container.
      RestartForceExitStatus = "133";
      SuccessExitStatus = "133";
      Restart = "on-failure";
      TimeoutStartSec = "2min";
      DevicePolicy = "closed";
    };
  };
}

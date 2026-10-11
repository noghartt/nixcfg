# Agent sandboxes: one systemd-nspawn container per sandbox, booted from a
# writable btrfs snapshot of a Nix-built base image under /agent (disk.nix).
# Isolation: a private user namespace (container root is an unprivileged host
# uid range), its own veth with internet-only egress, no host bind mounts, its
# own Nix store, and per-sandbox cgroup limits. `agentbox` (any member of the
# agentbox group) drives `agentbox-root`, the only privileged entry point.
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

  # Per sandbox; agentbox.slice below caps all of them together.
  limits = [
    "MemoryMax=16G"
    "MemorySwapMax=4G"
    "CPUQuota=800%"
    "TasksMax=4096"
    "IOWeight=50"
  ];

  agentbox-root = pkgs.writeShellApplication {
    name = "agentbox-root";
    runtimeInputs = [
      pkgs.btrfs-progs
      pkgs.coreutils
      pkgs.util-linux
      config.nix.package
      config.systemd.package
    ];
    text = ''
      IMAGE=${image}
      LIMITS=(${lib.escapeShellArgs limits})
    ''
    + builtins.readFile ./agentbox-root.sh;
  };

  agentbox = pkgs.writeShellApplication {
    name = "agentbox";
    runtimeInputs = [
      pkgs.coreutils
      pkgs.git
    ];
    text = ''
      AGENTBOX_ROOT=${lib.getExe agentbox-root}
    ''
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

  # Everything a sandbox must not reach: this host, the LAN, the tailnet,
  # other sandboxes, and special-purpose ranges.
  blocked = [
    "0.0.0.0/8"
    "10.0.0.0/8"
    "100.64.0.0/10"
    "127.0.0.0/8"
    "169.254.0.0/16"
    "172.16.0.0/12"
    "192.0.0.0/24"
    "192.168.0.0/16"
    "198.18.0.0/15"
    "224.0.0.0/4"
    "240.0.0.0/4"
  ];
in
{
  assertions = [
    {
      assertion = !config.networking.nftables.enable;
      message = "hosts/mellon/sandboxes isolates sandboxes with iptables rules; port them before enabling nftables.";
    }
  ];

  environment.systemPackages = [ agentbox ];

  users.groups.agentbox = { };
  security.sudo.extraRules = [
    {
      groups = [ "agentbox" ];
      commands = [
        {
          command = lib.getExe agentbox-root;
          options = [ "NOPASSWD" ];
        }
      ];
    }
  ];
  # Cloud mode calls it once per tool call; logging each would flood the journal.
  security.sudo.extraConfig = ''
    Defaults!${lib.getExe agentbox-root} !log_allowed
  '';

  systemd.slices.agentbox = {
    description = "Agent sandboxes";
    sliceConfig = {
      MemoryMax = "40G";
      CPUQuota = "2400%";
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

  # networkd handles only the sandboxes' veths, from per-sandbox runtime files
  # agentbox-root writes (fixed /28 in 10.231.0.0/16, DHCP server, masquerade);
  # NetworkManager keeps the uplink and must leave these links alone.
  systemd.network = {
    enable = true;
    wait-online.enable = false;
  };
  networking.networkmanager.unmanaged = [ "interface-name:ve-ab-*" ];

  # Tailnet devices reach sandboxes directly: the sandbox range is a subnet
  # route (approve it once in the admin console), and <name>.sandbox.internal
  # resolves through split DNS pointed at this host's tailnet address.
  services.tailscale = {
    useRoutingFeatures = "server";
    extraSetFlags = [ "--advertise-routes=10.231.0.0/16" ];
  };
  systemd.tmpfiles.rules = [ "d /run/agentbox/dns 0755 root root -" ];
  services.dnsmasq = {
    enable = true;
    resolveLocalQueries = false;
    settings = {
      interface = "tailscale0";
      except-interface = "lo";
      # tailscale0 may come up after dnsmasq.
      bind-dynamic = true;
      no-resolv = true;
      no-hosts = true;
      local = "/sandbox.internal/";
      hostsdir = "/run/agentbox/dns";
    };
  };
  networking.firewall.interfaces.tailscale0 = {
    allowedUDPPorts = [ 53 ];
    allowedTCPPorts = [ 53 ];
  };
  networking.firewall.interfaces."ve-ab-+".allowedUDPPorts = [ 67 ];

  # The policy lives in mangle, which runs before every filter chain, so
  # tailscaled's and Docker's own FORWARD accepts cannot get around it, however
  # their jumps end up ordered. New connections: sandbox -> this host only for
  # DHCP, sandbox -> public IPv4 only, into a sandbox only from the tailnet;
  # no IPv6 at all. Filter then only has to let the survivors past Docker's
  # FORWARD DROP policy.
  networking.firewall.extraCommands = ''
    ip46tables -t mangle -N agentbox-in 2>/dev/null || ip46tables -t mangle -F agentbox-in
    iptables -t mangle -A agentbox-in -p udp --dport 67 -j RETURN
    iptables -t mangle -A agentbox-in -m conntrack --ctstate NEW,INVALID -j DROP
    ip6tables -t mangle -A agentbox-in -j DROP
    ip46tables -t mangle -D INPUT -i ve-ab-+ -j agentbox-in 2>/dev/null || true
    ip46tables -t mangle -I INPUT -i ve-ab-+ -j agentbox-in

    ip46tables -t mangle -N agentbox-fwd 2>/dev/null || ip46tables -t mangle -F agentbox-fwd
    ip6tables -t mangle -A agentbox-fwd -i ve-ab-+ -j DROP
    ip6tables -t mangle -A agentbox-fwd -o ve-ab-+ -j DROP
    iptables -t mangle -A agentbox-fwd -m conntrack --ctstate INVALID -i ve-ab-+ -j DROP
    ${lib.concatMapStrings (net: ''
      iptables -t mangle -A agentbox-fwd -i ve-ab-+ -m conntrack --ctstate NEW -d ${net} -j DROP
    '') blocked}
    iptables -t mangle -A agentbox-fwd -o ve-ab-+ ! -i tailscale0 -m conntrack --ctstate NEW,INVALID -j DROP
    ip46tables -t mangle -D FORWARD -j agentbox-fwd 2>/dev/null || true
    ip46tables -t mangle -I FORWARD -j agentbox-fwd

    iptables -N agentbox-fwd 2>/dev/null || iptables -F agentbox-fwd
    iptables -A agentbox-fwd -i ve-ab-+ -j ACCEPT
    iptables -A agentbox-fwd -o ve-ab-+ -j ACCEPT
    iptables -D FORWARD -j agentbox-fwd 2>/dev/null || true
    iptables -I FORWARD -j agentbox-fwd

    # The first layout's filter chains outlive a firewall reload; its INPUT
    # chain also dropped replies to connections this host opens into sandboxes.
    ip46tables -D INPUT -i ve-ab-+ -j agentbox-in 2>/dev/null || true
    ip46tables -F agentbox-in 2>/dev/null && ip46tables -X agentbox-in 2>/dev/null || true
    ip6tables -D FORWARD -j agentbox-fwd 2>/dev/null || true
    ip6tables -F agentbox-fwd 2>/dev/null && ip6tables -X agentbox-fwd 2>/dev/null || true
  '';
  networking.firewall.extraStopCommands = ''
    ip46tables -t mangle -D INPUT -i ve-ab-+ -j agentbox-in 2>/dev/null || true
    ip46tables -t mangle -D FORWARD -j agentbox-fwd 2>/dev/null || true
    iptables -D FORWARD -j agentbox-fwd 2>/dev/null || true
  '';
}

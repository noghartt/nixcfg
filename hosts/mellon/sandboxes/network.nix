# Sandbox networking: veths and DHCP (networkd, from the per-sandbox files
# agentbox-root writes), the sandbox resolver, tailnet reachability, and each
# sandbox's egress policy (its net profile, net-profiles.nix).
{
  config,
  lib,
  pkgs,
  ...
}:
let
  net = import ./net-sets.nix { inherit lib; };

  # Everything a sandbox must not reach whatever its profile: this host, the
  # LAN, the tailnet, other sandboxes, and special-purpose ranges.
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

  # Every sandbox's DHCP lease names this resolver (its veth's host address).
  # Answers for an allowlisted profile's domains also land in that profile's
  # destination set, which is what its sandboxes may connect to. TTLs are
  # capped so that, after a restart empties the sets, sandboxes ask again (and
  # refill them) within five minutes. Sandboxes have no IPv6, so AAAA answers
  # would only cost them a failed attempt.
  resolver = pkgs.writeText "agentbox-dns.conf" ''
    interface=ve-ab-*
    except-interface=lo
    bind-dynamic
    no-resolv
    no-hosts
    server=1.1.1.1
    server=9.9.9.9
    domain-needed
    bogus-priv
    filter-AAAA
    max-ttl=300
    max-cache-ttl=300
    pid-file=/run/agentbox-dns/dnsmasq.pid
    ${lib.concatMapStrings (name: ''
      ipset=/${lib.concatStringsSep "/" net.profiles.${name}.domains}/${net.dst name}
    '') net.allowlisted}
  '';

  ipt = lib.concatMapStrings;
in
{
  assertions = [
    {
      assertion = !config.networking.nftables.enable;
      message = "hosts/mellon/sandboxes isolates sandboxes with iptables rules; port them before enabling nftables.";
    }
    {
      assertion = net.valid && lib.elem net.default net.names;
      message = "net-profiles.nix: profile names are a-z0-9 words of at most 16 characters, and the default must be one of them.";
    }
  ];

  # Loaded up front rather than on first use by the firewall script.
  boot.kernelModules = [
    "ip_set"
    "ip_set_hash_ip"
    "ip_set_hash_net"
    "xt_set"
  ];

  # Tailnet devices reach sandboxes directly: the sandbox range is a subnet
  # route (approve it once in the admin console), and <name>.sandbox.internal
  # resolves through split DNS pointed at this host's tailnet address.
  services.tailscale = {
    useRoutingFeatures = "server";
    extraSetFlags = [ "--advertise-routes=10.231.0.0/16" ];
  };
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

  # networkd handles only the sandboxes' veths, from per-sandbox runtime files
  # agentbox-root writes (fixed /28 in 10.231.0.0/16, DHCP server, masquerade).
  systemd = {
    network = {
      enable = true;
      wait-online.enable = false;
    };
    tmpfiles.rules = [ "d /run/agentbox/dns 0755 root root -" ];

    # A second dnsmasq, bound only to the sandboxes' veths (which come and go,
    # hence bind-dynamic), so the tailnet one never forwards and this one never
    # serves the tailnet. Starting empties the destination sets: they then hold
    # only what the current domain lists resolve to.
    services.agentbox-dns = {
      description = "DNS resolver for agent sandboxes";
      wantedBy = [ "multi-user.target" ];
      after = [
        "network.target"
        "firewall.service"
      ];
      path = [ pkgs.ipset ];
      preStart =
        net.create
        + lib.concatMapStrings (name: ''
          ipset flush ${net.dst name}
        '') net.allowlisted;
      serviceConfig = {
        ExecStart = "${pkgs.dnsmasq}/bin/dnsmasq --keep-in-foreground --conf-file=${resolver}";
        RuntimeDirectory = "agentbox-dns";
        Restart = "always";
      };
    };
  };

  networking = {
    # NetworkManager keeps the uplink and must leave the veths alone.
    networkmanager.unmanaged = [ "interface-name:ve-ab-*" ];
    firewall = {
      interfaces = {
        tailscale0 = {
          allowedUDPPorts = [ 53 ];
          allowedTCPPorts = [ 53 ];
        };
        "ve-ab-+" = {
          allowedUDPPorts = [
            53
            67
          ];
          allowedTCPPorts = [ 53 ];
        };
      };

      # The policy lives in mangle, which runs before every filter chain, so
      # tailscaled's and Docker's own FORWARD accepts cannot get around it, however
      # their jumps end up ordered. A packet from a sandbox must carry an address
      # of its own /28 (strict reverse-path check; the host-wide one is loose), so
      # its source address says which sandbox, and so which profile set, it is.
      # New connections: sandbox -> this host only for DHCP and, with egress, DNS;
      # sandbox -> public IPv4 only as its profile allows (DNS elsewhere is
      # redirected to the sandbox resolver for allowlisted profiles); into a
      # sandbox only from the tailnet; no IPv6 at all. Filter then only has to let
      # the survivors past Docker's FORWARD DROP policy.
      extraPackages = [ pkgs.ipset ];
      extraCommands = ''
        ${net.create}
        iptables -t mangle -N agentbox-pre 2>/dev/null || iptables -t mangle -F agentbox-pre
        iptables -t mangle -A agentbox-pre -p udp --dport 67 -j RETURN
        iptables -t mangle -A agentbox-pre -m rpfilter --invert -j DROP
        iptables -t mangle -D PREROUTING -i ve-ab-+ -j agentbox-pre 2>/dev/null || true
        iptables -t mangle -I PREROUTING -i ve-ab-+ -j agentbox-pre

        iptables -t nat -N agentbox-dns 2>/dev/null || iptables -t nat -F agentbox-dns
        ${ipt (name: ''
          iptables -t nat -A agentbox-dns -p udp --dport 53 -m set --match-set ${net.src name} src -j REDIRECT
          iptables -t nat -A agentbox-dns -p tcp --dport 53 -m set --match-set ${net.src name} src -j REDIRECT
        '') net.allowlisted}
        iptables -t nat -D PREROUTING -i ve-ab-+ -j agentbox-dns 2>/dev/null || true
        iptables -t nat -I PREROUTING -i ve-ab-+ -j agentbox-dns

        ip46tables -t mangle -N agentbox-in 2>/dev/null || ip46tables -t mangle -F agentbox-in
        iptables -t mangle -A agentbox-in -p udp --dport 67 -j RETURN
        ${ipt (name: ''
          iptables -t mangle -A agentbox-in -p udp --dport 53 -m set --match-set ${net.src name} src -j RETURN
          iptables -t mangle -A agentbox-in -p tcp --dport 53 -m set --match-set ${net.src name} src -j RETURN
        '') net.egress}
        iptables -t mangle -A agentbox-in -m conntrack --ctstate NEW,INVALID -j DROP
        ip6tables -t mangle -A agentbox-in -j DROP
        ip46tables -t mangle -D INPUT -i ve-ab-+ -j agentbox-in 2>/dev/null || true
        ip46tables -t mangle -I INPUT -i ve-ab-+ -j agentbox-in

        ip46tables -t mangle -N agentbox-fwd 2>/dev/null || ip46tables -t mangle -F agentbox-fwd
        ip6tables -t mangle -A agentbox-fwd -i ve-ab-+ -j DROP
        ip6tables -t mangle -A agentbox-fwd -o ve-ab-+ -j DROP
        iptables -t mangle -A agentbox-fwd -m conntrack --ctstate INVALID -i ve-ab-+ -j DROP
        ${ipt (range: ''
          iptables -t mangle -A agentbox-fwd -i ve-ab-+ -m conntrack --ctstate NEW -d ${range} -j DROP
        '') blocked}
        ${ipt (name: ''
          iptables -t mangle -A agentbox-fwd -i ve-ab-+ -m conntrack --ctstate NEW -m set --match-set ${net.src name} src -j RETURN
        '') net.open}
        iptables -t mangle -A agentbox-fwd -i ve-ab-+ -m conntrack --ctstate NEW -p udp -m multiport --dports 53,853 -j DROP
        iptables -t mangle -A agentbox-fwd -i ve-ab-+ -m conntrack --ctstate NEW -p tcp -m multiport --dports 53,853 -j DROP
        ${ipt (name: ''
          iptables -t mangle -A agentbox-fwd -i ve-ab-+ -m conntrack --ctstate NEW -m set --match-set ${net.src name} src -m set --match-set ${net.dst name} dst -j RETURN
        '') net.allowlisted}
        iptables -t mangle -A agentbox-fwd -i ve-ab-+ -m conntrack --ctstate NEW -j DROP
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
      extraStopCommands = ''
        iptables -t mangle -D PREROUTING -i ve-ab-+ -j agentbox-pre 2>/dev/null || true
        iptables -t nat -D PREROUTING -i ve-ab-+ -j agentbox-dns 2>/dev/null || true
        ip46tables -t mangle -D INPUT -i ve-ab-+ -j agentbox-in 2>/dev/null || true
        ip46tables -t mangle -D FORWARD -j agentbox-fwd 2>/dev/null || true
        iptables -D FORWARD -j agentbox-fwd 2>/dev/null || true
      '';
    };
  };
}

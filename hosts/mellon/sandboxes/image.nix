# The NixOS system every agent sandbox boots. It carries its own Nix store and
# daemon (copied into the base subvolume by `agentbox-root base`), so nothing
# from the host store, home, or sockets is visible inside.
{
  config,
  lib,
  pkgs,
  ...
}:
{
  boot.isContainer = true;
  networking.hostName = "sandbox";

  # nspawn has already mounted /dev, /dev/pts, /dev/shm and /run, and inside a
  # private user namespace those mounts are locked: the stock snippet's remounts
  # fail on every boot. Mount only what is missing.
  system.activationScripts.specialfs = lib.mkForce ''
    specialMount() {
      if mountpoint -q "$2"; then return 0; fi
      mkdir -p "$2"
      chmod 0755 "$2"
      mount -t "$4" -o "$3" "$1" "$2"
    }
    source ${config.system.build.earlyMountScript}
  '';
  # The /tmp tmpfs is nspawn's and locked the same way, so stopping it at
  # shutdown always fails; the container's mount namespace goes away anyway.
  systemd.units."tmp.mount" = {
    overrideStrategy = "asDropin";
    text = ''
      [Unit]
      DefaultDependencies=no
    '';
  };

  # The host side of each veth runs a DHCP server (networkd) that hands out an
  # address and the host's sandbox resolver (network.nix), the one DNS server
  # every net profile with egress may use.
  networking.useNetworkd = true;
  networking.useHostResolvConf = false;
  # The host's rules decide who may connect (only the tailnet); a firewall in
  # here would only hide servers the agent starts from the user.
  networking.firewall.enable = false;
  # Sorts before systemd's own 80-container-host0.network, which would win.
  systemd.network.networks."10-host0" = {
    matchConfig.Name = "host0";
    networkConfig = {
      DHCP = "ipv4";
      LinkLocalAddressing = "no";
      IPv6AcceptRA = false;
    };
  };

  nix.settings = {
    experimental-features = [
      "nix-command"
      "flakes"
    ];
    # Nested user namespaces may be refused inside the container; fall back
    # to unsandboxed builds rather than failing them.
    sandbox-fallback = lib.mkForce true;
  };

  # The account cloud mode and `agentbox exec` run as. uid/gid are fixed:
  # the host helper enters the container with exactly these ids.
  users.users.agent = {
    isNormalUser = true;
    uid = 1000;
    home = "/home/agent";
  };

  programs.direnv.enable = true;
  environment.systemPackages = with pkgs; [
    curl
    fd
    file
    gh
    git
    gnumake
    jq
    python3
    ripgrep
    tree
    unzip
    wget
  ];

  documentation.enable = false;
  system.stateVersion = "26.11";
}

# The NixOS system every agent sandbox boots. It carries its own Nix store and
# daemon (copied into the base subvolume by `agentbox-root base`), so nothing
# from the host store, home, or sockets is visible inside.
{ lib, pkgs, ... }:
{
  boot.isContainer = true;
  networking.hostName = "sandbox";

  # The host side of each veth runs a DHCP server (networkd) that hands out an
  # address and public resolvers; the host's own resolver is not reachable.
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

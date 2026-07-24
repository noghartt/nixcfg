{ pkgs, ... }:
{
  networking = {
    networkmanager.dns = "systemd-resolved";

    # Keep firewall state declarative; service modules add their required ports.
    firewall.enable = true;
  };

  services = {
    resolved.enable = true;

    tailscale = {
      enable = true;
      openFirewall = true;
    };

    cloudflare-warp.enable = true;
  };

  programs.wireshark = {
    enable = true;
    package = pkgs.wireshark;
  };
}

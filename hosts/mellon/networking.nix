{ pkgs, ... }:
{
  networking = {
    networkmanager = {
      enable = true;
      dns = "systemd-resolved";

      # A mains-powered desktop benefits more from predictable latency than
      # Wi-Fi power savings, especially with the young RTL8922AE driver.
      wifi.powersave = false;
    };

    firewall = {
      enable = true;
      # Tailscale and WARP use independent policy-routing tables.
      checkReversePath = "loose";
    };
  };

  services = {
    resolved = {
      enable = true;
      settings.Resolve.LLMNR = false;
    };

    tailscale = {
      enable = true;
      openFirewall = true;
      # tailscaled only accepts state changes (login, up, set) from root or its
      # operator; without this every `tailscale login` needs sudo.
      extraSetFlags = [ "--operator=noghartt" ];
    };

    # The daemon stays available, but the work tunnel is connected on demand.
    # Its managed profile must exclude Tailscale ranges and use traffic-only DNS.
    cloudflare-warp.enable = true;
  };

  programs.wireshark = {
    enable = true;
    package = pkgs.wireshark;
  };
}

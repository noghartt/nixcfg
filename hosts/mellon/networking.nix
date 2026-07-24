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

    # Keep firewall state declarative; service modules add their required ports.
    firewall.enable = true;
  };

  services = {
    resolved = {
      enable = true;
      settings.Resolve.LLMNR = false;
    };

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

# Docker daemon. overlay2 on btrfs is the sane default; the native btrfs
# storage driver spams a subvolume per image layer. The container toolkit
# passes the 5070 Ti through to CUDA workloads in containers.
{
  virtualisation.docker = {
    enable = true;

    # Published ports (`-p 8080:80`) go through Docker's own iptables rules,
    # which bypass the NixOS firewall and would expose them to the LAN.
    # Default them to loopback; reach them over SSH or `tailscale serve`.
    daemon.settings.ip = "127.0.0.1";

    # Bound root-volume growth without deleting persistent volumes.
    autoPrune = {
      enable = true;
      dates = "weekly";
      flags = [ "--filter=until=720h" ];
    };
  };

  hardware.nvidia-container-toolkit.enable = true;
}

# Docker daemon. overlay2 on btrfs is the sane default; the native btrfs
# storage driver spams a subvolume per image layer. The container toolkit
# passes the 5070 Ti through to CUDA workloads in containers.
{
  virtualisation.docker = {
    enable = true;

    # Bound root-volume growth without deleting persistent volumes.
    autoPrune = {
      enable = true;
      dates = "weekly";
      flags = [ "--filter=until=720h" ];
    };
  };

  hardware.nvidia-container-toolkit.enable = true;
}

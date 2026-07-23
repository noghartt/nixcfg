# Docker daemon. overlay2 on btrfs is the sane default; the native btrfs
# storage driver spams a subvolume per image layer. The container toolkit
# passes the 5070 Ti through to CUDA workloads in containers.
{
  virtualisation.docker.enable = true;

  hardware.nvidia-container-toolkit.enable = true;
}

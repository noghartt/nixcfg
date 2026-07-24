# mellon's GPU: NVIDIA RTX 5070 Ti (Blackwell). open = true is REQUIRED —
# the proprietary kernel module does not support Blackwell — and
# modesetting is required for Wayland. The old env-var workarounds
# (GBM_BACKEND, __GLX_VENDOR_LIBRARY_NAME, LIBVA_DRIVER_NAME) are
# obsolete with the open kernel module and deliberately absent.
# Adapted from github:fersilva16/nix-config (modules/linux/nvidia.nix).
{
  hardware.graphics = {
    enable = true;
    enable32Bit = true;
  };

  services.xserver.videoDrivers = [ "nvidia" ];

  hardware.nvidia = {
    open = true;
    modesetting.enable = true;
    nvidiaSettings = true;

    # Preserve VRAM across suspend and hibernate; fine-grained RTD3 is only
    # appropriate for PRIME offload laptops.
    powerManagement.enable = true;
  };

  boot.kernelParams = [
    "nvidia_drm.modeset=1"
    "nvidia_drm.fbdev=1"
  ];
}

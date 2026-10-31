# mellon's GPU: NVIDIA RTX 5070 Ti (Blackwell). The nixos-hardware
# architecture module selects the required open kernel module. Modesetting
# remains host policy because Niri requires it. The old env-var workarounds
# are obsolete with the open kernel module and deliberately absent.
# Adapted from github:fersilva16/nix-config (modules/linux/nvidia.nix).
{
  config,
  flake,
  ...
}:
let
  package = config.boot.kernelPackages.nvidiaPackages.mkDriver {
    # 595.84 calls strncpy, which Linux 7.2 removed; .112 builds on 7.2.
    version = "595.112.07";
    sha256_64bit = "sha256-Gjjs1Tii2mIypzMBhAY69Z6fyUbJCMylVb0HkJhIufA=";
    openSha256 = "sha256-nQnXGCcvo4i7eGaVft3Xc9dRUPPH0v9Zi87cfI4i/Ys=";
    settingsSha256 = "sha256-2bWSou/9J3EojhSRXBol/+yGGu2XZ6EuCptb5qXHM14=";
    persistencedSha256 = "sha256-cGMEUXN7WPu822zZDLTSu6Owj8VXG4PNmhe9oKqMMKI=";
  };
in
{
  imports = [ "${flake.inputs.nixos-hardware}/common/gpu/nvidia/blackwell" ];

  hardware.graphics = {
    enable = true;
    enable32Bit = true;
  };

  hardware.nvidia = {
    inherit package;
    modesetting.enable = true;
    nvidiaSettings = true;
  };

  # CUDA builds are unfree, so cache.nixos.org never has them; without this
  # cache any CUDA package (agent sandboxes, ollama) compiles from source. Set
  # on the host, not in flake nixConfig, which non-interactive sudo rebuilds
  # ignore. Key from wiki.nixos.org/wiki/CUDA; adapted from fersilva16.
  nix.settings = {
    extra-substituters = [ "https://cache.nixos-cuda.org" ];
    extra-trusted-public-keys = [
      "cache.nixos-cuda.org:74DUi4Ye579gUqzH4ziL9IyiJBlDpMRn9MBN8oNan9M="
    ];
  };
}

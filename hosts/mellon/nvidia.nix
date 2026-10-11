# mellon's GPU: NVIDIA RTX 5070 Ti (Blackwell). The nixos-hardware
# architecture module selects the required open kernel module. Modesetting
# remains host policy because Hyprland requires it. The old env-var workarounds
# are obsolete with the open kernel module and deliberately absent.
# Adapted from github:fersilva16/nix-config (modules/linux/nvidia.nix).
{
  config,
  flake,
  ...
}:
let
  package = config.boot.kernelPackages.nvidiaPackages.mkDriver {
    version = "595.84";
    sha256_64bit = "sha256-mcQE5SExvye8ptoCaNzOPr7cenOrF0BxqZXPGmxeugY=";
    openSha256 = "sha256-pEmA2tUcOKwUPKy6N0QvS49Pdut4/7Phs/JhjdyBcNY=";
    settingsSha256 = "sha256-QrnBM+sdWO4GanO62rxpHmRrjYkYpl5RD6fIiHq4C4A=";
    persistencedSha256 = "sha256-50xYdgx7EEThbaMp4QS8GADbxj0mhBXh8QQN0tWMwRg=";
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

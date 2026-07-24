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

    # Preserve VRAM across suspend and hibernate; fine-grained RTD3 is only
    # appropriate for PRIME offload laptops.
    powerManagement.enable = true;
  };
}

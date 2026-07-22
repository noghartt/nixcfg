# PLACEHOLDER so the flake evaluates before installation.
# Replace with the output of `nixos-generate-config` on the real machine
# (see TASK.md). Do not hand-edit after that point.
{ lib, ... }:
{
  nixpkgs.hostPlatform = lib.mkDefault "x86_64-linux";

  fileSystems."/" = {
    device = "/dev/disk/by-label/nixos";
    fsType = "ext4";
  };

  fileSystems."/boot" = {
    device = "/dev/disk/by-label/ESP";
    fsType = "vfat";
  };

  boot.initrd.availableKernelModules = [ "nvme" ];
}

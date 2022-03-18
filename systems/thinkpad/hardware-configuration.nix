{ modulesPath, lib, ... }:

let
  btrfsDevice = "/dev/disk/by-label/root";
in
{
  imports = [
    # TODO: Fix that
    (modulesPath + "/profiles/qemu-guest.nix")
  ];

  boot.kernelModules = [ "kvm-amd" ];
  boot.extraModulePackages = [  ];

  boot.initrd = {
    # TODO: Remove `ata_piix`, `floppy` and `sr_mod`
    availableKernelModules = [ "ata_piix" "nvme" "sr_mod" ];
    kernelModules = [ ];
    supportedFilesystems = [ "btrfs" ];
  };

  boot.initrd.luks.devices."lvm".device = "/dev/nvme0n1p2";

  fileSystems = {
    "/boot" = {
      device = "/dev/disk/by-label/boot";
      fsType = "vfat";
    };

    "/" = {
      device = btrfsDevice;
      fsType = "btrfs";
      options = [ "subvol=root" ];
    };

    "/home" = {
      device = btrfsDevice;
      fsType = "btrfs";
      options = [ "subvol=home" ];
    };
  };

  swapDevices = [ ];

  nix.settings.max-jobs = lib.mkDefault 4;
  powerManagement.cpuFreqGovernor = lib.mkDefault "powersave";
}

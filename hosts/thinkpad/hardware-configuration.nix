{ modulesPath, lib, ... }:

let
  btrfsDevice = "/dev/disk/by-label/root";
in
{
  imports = [
    (modulesPath + "/installer/scan/not-detected.nix")
  ];

  boot.extraModulePackages = [  ];

  boot.initrd = {
    availableKernelModules = [ "nvme" "ahci" "usb_storage" "usbhid" "sd_mod" "xhci_pci" ];
    kernelModules = [ "kvm-amd" ];
    supportedFilesystems = [ "btrfs" ];

    luks.devices."lvm" = {
      device = "/dev/nvme0n1p2";
      preLVM = true;
      allowDiscards = true;
    };
  };

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

    "/nix" = {
      device = btrfsDevice;
      fsType = "btrfs";
      options = [ "subvol=nix" ];
    };
  };

  swapDevices = [{ device = "/var/swapfile"; size = (1024 * 8) + (1024 * 2); }];

  nix.settings.max-jobs = lib.mkDefault 4;
  powerManagement.cpuFreqGovernor = lib.mkDefault "ondemand";
}

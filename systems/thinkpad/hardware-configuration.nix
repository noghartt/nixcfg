{ modulesPath, ... }:

let
  btrfsDevice = "/dev/disk/by-label/root";
in
{
  imports = [
    (modulesPath + "/installer/scan/not-detected.nix")
  ];

  boot.initrd = {
    availableKernelModules = [ "nvme" "xhci_pci" "ahci" "usb_storage" "usbhid" "sd_mod" ];
    kernelModules = [ "kvm-amd" ];

    luks.devices."lvm".device = "/dev/disk/by-label/root";
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
  };
}

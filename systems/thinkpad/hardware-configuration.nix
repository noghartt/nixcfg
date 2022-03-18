{ modulesPath, lib, ... }:

let
  btrfsDevice = "/dev/disk/by-label/root";
in
{
  imports = [
    "${modulesPath}/installer/scan/not-detected.nix"
  ];

  boot.initrd = {
    availableKernelModules = [ "nvme" "xhci_pci" "ahci" "usb_storage" "usbhid" "sd_mod" ];
    kernelModules = [ "kvm-amd" ];
    supportedFilesystems = [ "btrfs" ];

    postDeviceCommands = ''
      mkdir -p /mnt
      mount -o subvol=root ${btrfsDevice} /mnt

      echo "Cleaning subvolume"
      btrfs subvolume list -o /mnt/root | cut -f9 -d ' ' |
      while read subvolume; do
        btrfs subvolume delete "/mnt/$subvolume"
      done && btrfs subvolume delete /mnt/root

      echo "Restoring blank subvolume"
      btrfs subvolume snapshot /mnt/root-blank /mnt/root

      umount /mnt
    '';
  };

  boot.initrd.luks.devices."lvm".device = btrfsDevice;

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

  nix.settings.maxJobs = lib.mkDefault 4;
  powerManagement.cpuFreqGovernor = lib.mkDefault "powersave";
}

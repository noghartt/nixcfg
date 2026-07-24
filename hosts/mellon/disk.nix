# Disk layout (disko) for mellon's 2TB Kingston NVMe:
# GPT -> ESP + LUKS -> LVM vg -> btrfs LVs.
# Sizes and subvolumes follow the previous Arch install (@, @snapshots,
# @var_log on root), plus @nix and @swap for NixOS. home takes whatever
# the root LV leaves; it is the filesystem that actually grows.
# INSTALL ONLY: disko wipes the disk.
{ flake, ... }:
let
  # Mount options carried over from the Arch setup (see the gist reference
  # in TASK.md), with zstd over lzo and space_cache=v2 (v1 is deprecated).
  btrfsOpts = [
    "compress=zstd"
    "noatime"
    "ssd"
    "space_cache=v2"
  ];
in
{
  imports = [ flake.inputs.disko.nixosModules.disko ];

  disko.devices = {
    disk.main = {
      type = "disk";
      device = "/dev/disk/by-id/nvme-KINGSTON_SFYRDK2000G_50026B7283A261E1";
      content = {
        type = "gpt";
        partitions = {
          ESP = {
            # NixOS keeps configurationLimit (20) kernel+initrd pairs on the
            # ESP; 1G gets tight with current 7.x kernels.
            size = "2G";
            type = "EF00";
            content = {
              type = "filesystem";
              format = "vfat";
              mountpoint = "/boot";
              mountOptions = [ "umask=0077" ];
            };
          };
          lvm = {
            size = "100%";
            type = "8309";
            content = {
              type = "luks";
              name = "cryptlvm";

              # Provision this ephemeral file in the installer environment;
              # normal boots prompt interactively and never retain the secret.
              passwordFile = "/run/disko-luks-password";

              # Let weekly fstrim reach the NVMe, accepting that discard
              # reveals which encrypted blocks are allocated.
              settings.allowDiscards = true;

              content = {
                type = "lvm_pv";
                vg = "vg";
              };
            };
          };
        };
      };
    };

    lvm_vg.vg = {
      type = "lvm_vg";
      lvs = {
        root = {
          size = "500G";
          content = {
            type = "btrfs";
            extraArgs = [ "-f" ];
            subvolumes = {
              "@" = {
                mountpoint = "/";
                mountOptions = btrfsOpts;
              };
              "@nix" = {
                mountpoint = "/nix";
                mountOptions = btrfsOpts;
              };
              "@var_log" = {
                mountpoint = "/var/log";
                mountOptions = btrfsOpts;
              };
              "@snapshots" = {
                mountpoint = "/.snapshots";
                mountOptions = btrfsOpts;
              };
              # Sized for hibernation (60G RAM). Swap files on btrfs refuse
              # to activate on CoW subvolumes, hence nodatacow.
              "@swap" = {
                mountpoint = "/swap";
                mountOptions = [
                  "noatime"
                  "nodatacow"
                ];
                swap.swapfile.size = "64G";
              };
            };
          };
        };
        home = {
          size = "100%FREE";
          content = {
            type = "btrfs";
            extraArgs = [ "-f" ];
            subvolumes = {
              "@home" = {
                mountpoint = "/home";
                mountOptions = btrfsOpts;
              };
            };
          };
        };
      };
    };
  };

  # Runtime care for the layout above: monthly scrub catches bit-rot early.
  services.btrfs.autoScrub = {
    enable = true;
    interval = "monthly";
    fileSystems = [
      "/"
      "/home"
    ];
  };
}

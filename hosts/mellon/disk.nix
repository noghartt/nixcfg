# Disk layout (disko) for mellon's 2TB Kingston NVMe:
# GPT -> ESP + LVM vg -> btrfs LVs. No LUKS: unencrypted by choice.
# ~300G is deliberately left unallocated in the VG: growing or adding LVs
# later is the whole point of LVM. INSTALL ONLY: disko wipes the disk.
{ flake, ... }:
let
  # Mount options carried over from the Arch setup (see the gist reference
  # in TASK.md), with zstd over lzo and space_cache=v2 (v1 is deprecated).
  btrfsOpts = [
    "compress=zstd"
    "noatime"
    "ssd"
    "discard=async"
    "space_cache=v2"
    "autodefrag"
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
            size = "1G";
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
            type = "8E00";
            content = {
              type = "lvm_pv";
              vg = "vg";
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
          size = "1T";
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

# Disk layout (disko) for mellon's system NVMe, which it shares with an
# existing Windows install. disko never partitions this drive: INSTALL.md
# adds two partitions in the space Windows left free, labelled disk-main-ESP
# and disk-main-lvm, and disko only formats and mounts those (format,mount
# mode; destroy is off for both). Partition labels keep the layout drive- and
# size-agnostic, and Windows' partitions are never named here.
#   disk-main-ESP: 2G vfat at /boot, Linux's own ESP. Windows' ESP (~100M) is
#     too small: measured boot keeps 8 signed kernel+initrd generations, and
#     1G already gets tight with 7.x kernels.
#   disk-main-lvm: LUKS -> LVM vg -> btrfs LVs: root 500G, agents 300G
#     (sandboxes can never fill / or /home), home the rest.
# Sizes and subvolumes follow the previous Arch install (@, @snapshots,
# @var_log on root), plus @nix. No disk swap: Mellon never hibernates, and
# zram covers memory pressure.
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
    disk = {
      esp = {
        type = "disk";
        device = "/dev/disk/by-partlabel/disk-main-ESP";
        destroy = false;
        content = {
          type = "filesystem";
          format = "vfat";
          mountpoint = "/boot";
          mountOptions = [ "umask=0077" ];
        };
      };

      lvm = {
        type = "disk";
        device = "/dev/disk/by-partlabel/disk-main-lvm";
        destroy = false;
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
            };
          };
        };
        # Agent sandboxes and their images live here, apart from the user's
        # home and outside root's Snapper timeline. Grow it with lvextend +
        # `btrfs filesystem resize` after shrinking home.
        agents = {
          size = "300G";
          content = {
            type = "btrfs";
            extraArgs = [ "-f" ];
            subvolumes."@agent" = {
              mountpoint = "/agent";
              mountOptions = btrfsOpts;
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

  # Compressed swap in RAM: absorbs bursts from many agent sessions without
  # disk wear; per-sandbox cgroup limits do the real containment.
  zramSwap.enable = true;

  # Runtime care for the layout above: monthly scrub catches bit-rot early.
  services.btrfs.autoScrub = {
    enable = true;
    interval = "monthly";
    fileSystems = [
      "/"
      "/agent"
      "/home"
    ];
  };
}

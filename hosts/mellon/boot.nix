{
  flake,
  lib,
  pkgs,
  ...
}:
{
  imports = [ flake.inputs.lanzaboote.nixosModules.lanzaboote ];

  boot = {
    loader = {
      # Lanzaboote replaces the systemd-boot installer while retaining its
      # menu settings and signing every bootable generation.
      systemd-boot = {
        enable = lib.mkForce false;
        configurationLimit = 20;
        consoleMode = "max";
        # Kernel cmdline editing at boot would bypass the login password.
        editor = false;
      };
      efi.canTouchEfiVariables = true;
    };

    lanzaboote = {
      enable = true;
      pkiBundle = "/var/lib/sbctl";
    };

    initrd = {
      # systemd stage-1: clean LVM activation and reliable hibernate resume.
      systemd.enable = true;
      services.lvm.enable = true;
    };

    # Hibernation resume target (swapfile lives on the root LV, see
    # disk.nix). The offset is filesystem-specific and can only be read
    # after install:
    #   sudo btrfs inspect-internal map-swapfile -r /swap/swapfile
    # then add "resume_offset=<value>" to kernelParams below.
    resumeDevice = "/dev/mapper/vg-root";
    kernelParams = [
      # "resume_offset=REPLACE_AFTER_INSTALL"
    ];
  };

  environment.systemPackages = [ pkgs.sbctl ];
}

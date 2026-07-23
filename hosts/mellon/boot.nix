{
  boot = {
    loader = {
      # NixOS has no native EFISTUB bootloader; systemd-boot is the native
      # UEFI path (same as the previous Arch setup).
      systemd-boot = {
        enable = true;
        configurationLimit = 20;
        consoleMode = "max";
        # Kernel cmdline editing at boot would bypass the login password.
        editor = false;
      };
      efi.canTouchEfiVariables = true;
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
      "nowatchdog"
      # "resume_offset=REPLACE_AFTER_INSTALL"
    ];
  };
}

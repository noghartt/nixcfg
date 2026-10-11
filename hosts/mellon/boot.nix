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
        # systemd-pcrlock supports policy predictions for up to 8 generations.
        configurationLimit = 8;
        consoleMode = "max";
        # Kernel cmdline editing at boot would bypass the login password.
        editor = false;
      };
      efi.canTouchEfiVariables = true;
    };

    lanzaboote = {
      enable = true;
      pkiBundle = "/var/lib/sbctl";
      measuredBoot = {
        enable = true;
        # Bind unlock to Lanzaboote's verified boot chain and Secure Boot state.
        pcrs = [
          4
          7
        ];
      };
    };

    initrd = {
      # systemd stage-1: clean LVM activation and TPM2 unlock.
      systemd = {
        enable = true;
        tpm2.enable = true;
      };
      luks.devices.cryptlvm.crypttabExtraOpts = [ "tpm2-device=auto" ];
      services.lvm.enable = true;
    };
  };

  environment.systemPackages = [
    pkgs.sbctl
    # Windows Boot Manager lives on Windows' own ESP, outside systemd-boot's
    # menu; `efibootmgr --bootnext` reboots into it once.
    pkgs.efibootmgr
    # One-shot firmware boot keeps Windows' TPM measurements identical to a
    # direct boot, so BitLocker never sees systemd-boot in its chain. The entry
    # is found by label because its BootXXXX number moves when firmware or
    # Windows rewrites the boot entries.
    (pkgs.writeShellApplication {
      name = "reboot-windows";
      runtimeInputs = [ pkgs.efibootmgr ];
      text = ''
        entry=$(efibootmgr | sed -n 's/^Boot\([0-9A-Fa-f]\{4\}\)\*\{0,1\} Windows Boot Manager\t.*/\1/p' | head -n 1)
        if [ -z "$entry" ]; then
          echo "reboot-windows: no 'Windows Boot Manager' entry in efibootmgr" >&2
          exit 1
        fi
        sudo efibootmgr --quiet --bootnext "$entry"
        systemctl reboot
      '';
    })
  ];
}

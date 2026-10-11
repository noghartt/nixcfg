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
  ];
}

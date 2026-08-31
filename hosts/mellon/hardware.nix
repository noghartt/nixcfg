# Hand-written hardware settings for mellon (hardware-configuration.nix
# stays machine-generated). Detected pre-install on the machine:
# Ryzen 9 9950X, RTX 5070 Ti, RTL8922AE WiFi+BT, RTL8125 2.5GbE, ASUS board.
{
  flake,
  lib,
  pkgs,
  ...
}:
let
  hardwarePkgs = import flake.inputs.nixpkgs-hardware {
    system = pkgs.stdenv.hostPlatform.system;
    config.allowUnfree = true;
  };
in
{
  hardware = {
    # Keep the kernel-facing stack coherent and independent from userspace
    # updates. NetworkManager otherwise injects the main package set's regdb.
    enableRedistributableFirmware = false;
    wirelessRegulatoryDatabase = lib.mkForce false;
    firmware = [
      hardwarePkgs.linux-firmware
      hardwarePkgs.wireless-regdb
    ];

    cpu.amd = {
      updateMicrocode = true;
      microcodePackage = hardwarePkgs.microcode-amd;
    };
  };

  boot = {
    kernelPackages = hardwarePkgs.linuxPackages_7_1;

    initrd.availableKernelModules = [
      "nvme"
      "xhci_pci"
      "usbhid"
    ];

    kernelModules = [ "kvm-amd" ];

    # Establish the legal channel and power limits before userspace starts;
    # the matching pinned regulatory database is supplied above.
    kernelParams = [ "cfg80211.ieee80211_regdom=BR" ];
  };

  services.fwupd.enable = true;
}

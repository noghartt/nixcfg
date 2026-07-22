# Hand-written hardware settings for mellon (hardware-configuration.nix
# stays machine-generated). Detected pre-install on the machine:
# Ryzen 9 9950X, RTX 5070 Ti, RTL8922AE WiFi+BT, RTL8125 2.5GbE, ASUS board.
{
  pkgs,
  lib,
  config,
  ...
}:
{
  hardware = {
    # rtw89 firmware for the RTL8922AE lives in the redistributable set.
    enableRedistributableFirmware = true;
    cpu.amd.updateMicrocode = lib.mkDefault config.hardware.enableRedistributableFirmware;
  };

  boot = {
    # RTL8922AE (WiFi 7) does not probe on the default kernel (rtw89_8922ae
    # needs 7.x). Track latest until the default catches up. Known tension
    # from fersilva16's identical build: Blackwell suspend-to-idle can hang
    # on the newest kernels — if that hits, weigh WiFi vs suspend.
    kernelPackages = pkgs.linuxPackages_latest;

    initrd.availableKernelModules = [
      "nvme"
      "xhci_pci"
      "usbhid"
    ];

    kernelModules = [ "kvm-amd" ];
  };

  services.fwupd.enable = true;
}

{ pkgs, lib, inputs, system, ... }:

# TODO: This file should be improved in the future
# Maybe we can improve the collocation of the functions here
let
  inherit (inputs.nixos-hardware.nixosModules)
    common-cpu-amd
    common-gpu-amd
    lenovo-thinkpad-t14
  ;
in
{
  imports = [
    common-cpu-amd
    common-gpu-amd
    lenovo-thinkpad-t14

    ../common
    ../common/bootloader.nix
    ../common/xserver.nix
    ../common/pipewire.nix
    ../common/nix.nix
    ../common/bluetooth.nix
    ../common/fonts.nix

    ./hardware-configuration.nix
  ];

  boot = {
    kernelPackages = pkgs.linuxPackages_zen;
    kernelParams = [ "quiet" ];
  };

  networking = {
    networkmanager.enable = true;
    useDHCP = false;

    interfaces.wlp3s0 = {
      useDHCP = true;
      wakeOnLan.enable = true;
    };
  };

  console = {
    earlySetup = true;
    keyMap = "br-abnt2";
  };

  hardware.opengl = {
    enable = true;
    extraPackages = with pkgs; [ amdvlk ];
    driSupport = true;
  };
}

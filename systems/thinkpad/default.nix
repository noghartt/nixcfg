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

    ./hardware-configuration.nix
    ../../common/default.nix
  ];

  boot = {
    kernelPackages = pkgs.linuxPackages_zen;
    kernelParams = [ "quiet" ];
    supportedFilesystems = [ "btrfs" ];
    loader = {
      timeout = 10;
      efi.canTouchEfiVariables = true;
      systemd-boot = {
        enable = true;
        consoleMode = "max";
        editor = false;
      };
    };
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

  security.rtkit.enable = true;
  sound.enable = true;
  services.pipewire = {
    enable = true;
    alsa.enable = true;
    alsa.support32Bit = true;
    pulse.enable = true;
  };

  hardware.bluetooth.enable = true;

  hardware.opengl = {
    enable = true;
    extraPackages = with pkgs; [ amdvlk ];
    driSupport = true;
  };

  fonts = {
    enableDefaultFonts = true;
    # TODO: Add more fonts
    fonts = with pkgs; [
      noto-fonts
      noto-fonts-emoji
      noto-fonts-extra
      noto-fonts-cjk
    ];
  };
}

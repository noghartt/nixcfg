{ pkgs, lib, inputs, system, ... }:

# TODO: This file should be improved in the future
# Maybe we can improve the collocation of the functions here
let
  nur = import inputs.nur { nurpkgs = import inputs.nixpkgs { inherit system; };  };
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
  ];

  system.stateVersion = "21.11";

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
  };

  time.timeZone = "America/Sao_Paulo";

  i18n.defaultLocale = lib.mkDefault "pt_BR.UTF-8";

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

  environment = {
    loginShellInit = ''
      [ -d "$HOME/.nix-profile" ] || /nix/var/nix/profiles/per-user/$USER/home-manager/activate &> /dev/null
    '';
    homeBinInPath = true;
    localBinInPath = true;
  };

  nix = {
    package = pkgs.nixUnstable;
    gc = {
      automatic = true;
      options = "--delete-older-than 15d";
    };
    settings = {
      trusted-users = [ "root" "@wheel" ];
      auto-optimise-store = true;
    };
    extraOptions = ''
      experimental-features = nix-command flakes
    '';
  };

  hardware.opengl.enable = true;

  services.xserver = {
    enable = true;
    displayManager.startx.enable = true;
    windowManager.xmonad = {
      enable = true;
      enableContribAndExtras = true;
      extraPackages = haskellPackages: with haskellPackages; [
        xmonad
        xmonad-contrib
        xmonad-extras
        xmobar
      ];
    };
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

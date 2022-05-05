{ lib, pkgs, ... }:

{
  system.stateVersion = "21.11";

  environment.systemPackages = with pkgs; [
    wget
    curl
    vim
    usbutils
    pciutils
    xclip
    lm_sensors
    nixfmt
    rnix-lsp
  ];

  boot.cleanTmpDir = true;

  i18n.defaultLocale = lib.mkDefault "en_US.UTF8";
  time.timeZone = "America/Sao_Paulo";

  environment = {
    loginShellInit = ''
      [ -d "$HOME/.nix-profile" ] || /nix/var/nix/profiles/per-user/$USER/home-manager/activate &> /dev/null
    '';
    homeBinInPath = true;
    localBinInPath = true;

    etc."nixos" = {
      target = "nixos";
      source = "/dotfiles";
    };
  };
 }

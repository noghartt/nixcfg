{ lib, pkgs, ... }:

{
  system.stateVersion = "21.11";

  boot.cleanTmpDir = true;

  i18n.defaultLocale = lib.mkDefault "en_US.UTF8";
  time.timeZone = "America/Sao_Paulo";

  environment = {
    loginShellInit = ''
      [ -d "$HOME/.nix-profile" ] || /nix/var/nix/profiles/per-user/$USER/home-manager/activate &> /dev/null
    '';
    homeBinInPath = true;
    localBinInPath = true;
    systemPackages = with pkgs; [
      wget
      curl
      vim
    ];
  };

  nixpkgs.config.allowUnfree = true;

  nix = {
    package = pkgs.nixFlakes;
    settings = {
      trusted-users = [ "root" "@wheel" ];
      auto-optimise-store = true;
      experimental-features = [
        "nix-command"
        "flakes"
      ];
    };
    gc = {
      automatic = true;
      options = "--delete-older-than 15d";
    };
  };
}

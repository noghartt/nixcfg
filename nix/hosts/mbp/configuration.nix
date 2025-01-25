{ pkgs, ... } @ args:

let
  username = "noghartt";
  mkImports = import ../../lib/mkImports.nix args;
in
{
  system.stateVersion = 5;

  imports = mkImports {
    inherit username;

    imports = [
      ./homebrew.nix
      ./launchd.nix
    ];
  };

  services.nix-daemon.enable = true;

  environment.shells = with pkgs; [ fish zsh ];

  programs.fish.enable = true;

  users.users.noghartt = {
    home = "/Users/noghartt";

    shell = pkgs.fish;
  };

  nix.extraOptions = ''
    auto-optimise-store = true
    experimental-features = nix-command flakes
    extra-platforms = x86_64-darwin aarch64-darwin
  '';
}

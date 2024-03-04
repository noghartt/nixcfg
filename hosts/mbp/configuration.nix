{ lib, pkgs, ... }:

{
  services.nix-daemon.enable = true;

  imports = [
    ./homebrew.nix
  ];

  users.users.noghartt = {
    home = "/Users/noghartt";    
  };

  nix.extraOptions = ''
    auto-optimise-store = true
    experimental-features = nix-command flakes
  '' + lib.optionalString (pkgs.system == "aarch64-darwin") ''
    extra-platforms = x86_64-darwin aarch64-darwin
  '';

  homebrew = {
    enable = true;

    casks = [
      "discord"
    ];
  };
}

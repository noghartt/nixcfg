{
  pkgs,
  system,
  inputs,
  ...
}@args:

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

  environment.systemPackages = [
    inputs.agenix.packages.${system}.default
  ];

  environment.shells = with pkgs; [ zsh ];

  programs.zsh.enable = true;

  system.primaryUser = username;
  users.users.noghartt = {
    home = "/Users/noghartt";
    shell = pkgs.zsh;
  };

  nix.extraOptions = ''
    auto-optimise-store = true
    experimental-features = nix-command flakes
    extra-platforms = x86_64-darwin aarch64-darwin
  '';
}

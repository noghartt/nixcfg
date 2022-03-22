{ inputs, overlays ? [  ], pkgs, lib }:

let
  inherit (inputs) nixpkgs home-manager;
in
{
  # The `builtins.currentSystem` here is a mutable value, so you need to add
  # `--impure` flag in some cases.
  #
  # E.g.: nix flake check --impure
  #
  # TODO: This should be an impure value? Or we can add a default string value?
  # `"x86_64-linux"` for example.
  mkHost = { hostname, system ? builtins.currentSystem, users ? [  ] }:
    nixpkgs.lib.nixosSystem {
      inherit system;
      specialArgs = {
        inherit inputs system hostname;
      };
      modules = [
        ../hosts/${hostname}
        {
          networking.hostName = hostname;
          nixpkgs = {
            inherit overlays;
            config.allowUnfree = true;
          };
        }
      ] ++ lib.forEach users (user: ../users/${user});
    };

  mkHome= { username, system, hostname }:
    home-manager.lib.homeManagerConfiguration {
      inherit username system;
      extraSpecialArgs = {
        inherit system username hostname;
      };

      homeDirectory = "/home/${username}";
      configuration = ../users/${username}/home/home.nix;
      extraModules = [
        {
          nixpkgs = {
            inherit overlays;
            config.allowUnfree = true;
          };

          programs.home-manager.enable = true;
        }
      ];
    };
}

{
  description = "All-in-one Nix configuration: NixOS + home-manager (nix-darwin later)";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";

    home-manager = {
      url = "github:nix-community/home-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    disko = {
      url = "github:nix-community/disko";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    { self, nixpkgs, ... }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};

      libEx = import ./lib {
        inherit self;
        inherit (nixpkgs) lib;
      };
    in
    {
      # Custom option-only modules, auto-imported everywhere.
      nixosModules = import ./modules/nixos;
      homeManagerModules = import ./modules/home-manager;

      # User factories (home/<user>/user.nix), auto-discovered. Host specs
      # pick from these via their `users` field, optionally with per-host
      # overrides — see lib.mkNixOSConfig.
      users = libEx.mapDir (username: import ./home/${username}/user.nix) ./home;

      # Every directory in hosts/ (except common/) is a NixOS host.
      nixosConfigurations = nixpkgs.lib.filterAttrs (name: _: name != "common") (
        libEx.mapDir (
          hostName:
          libEx.mkNixOSConfig {
            inherit hostName;
            hostFile = ./hosts/${hostName};
          }
        ) ./hosts
      );

      devShells.${system}.default = pkgs.mkShell {
        packages = with pkgs; [
          deadnix
          nixd
          nixfmt
          statix
        ];
      };

      formatter.${system} = pkgs.nixfmt;
    };
}

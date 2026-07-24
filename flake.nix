{
  description = "All-in-one Nix configuration: NixOS + home-manager (nix-darwin later)";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";

    # Independently locked kernel, firmware, microcode, and out-of-tree modules.
    nixpkgs-hardware.url = "github:nixos/nixpkgs/nixos-unstable";

    home-manager = {
      url = "github:nix-community/home-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    disko = {
      url = "github:nix-community/disko";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    lanzaboote = {
      url = "github:nix-community/lanzaboote";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    # Packaged Firefox extensions (used by home/noghartt/features/desktop/firefox.nix).
    firefox-addons = {
      url = "gitlab:rycee/nur-expressions?dir=pkgs/firefox-addons";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    # 1Password secrets (see home/noghartt/features/cli/git.nix for the first consumer).
    opnix = {
      url = "github:brizzbuzz/opnix";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    # Native desktop shell for the Hyprland session.
    noctalia = {
      url = "github:noctalia-dev/noctalia";
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

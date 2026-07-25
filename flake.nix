{
  description = "All-in-one Nix configuration: NixOS + home-manager (nix-darwin later)";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";

    # Independently locked kernel, firmware, microcode, and out-of-tree modules.
    nixpkgs-hardware.url = "github:nixos/nixpkgs/nixos-unstable";

    nixos-hardware = {
      url = "github:NixOS/nixos-hardware";
      inputs.nixpkgs.follows = "nixpkgs-hardware";
    };

    home-manager = {
      url = "github:nix-community/home-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    # Darwin system wiring; the first host and shared user adapter remain TODO.
    nix-darwin = {
      url = "github:nix-darwin/nix-darwin/master";
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
      # Platforms this flake serves per-system outputs (checks, devShells,
      # formatter) for. Hosts declare their own platform via
      # `nixpkgs.hostPlatform`; this list only has to cover them.
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});

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

      checks = forAllSystems (
        pkgs:
        {
          formatting =
            pkgs.runCommand "nixcfg-formatting"
              {
                nativeBuildInputs = with pkgs; [
                  deadnix
                  findutils
                  nixfmt
                  statix
                ];
              }
              ''
                find ${self.outPath} -type f -name '*.nix' -exec nixfmt --check {} +
                statix check ${self.outPath}
                deadnix --fail ${self.outPath}
                touch $out
              '';
        }
        # Each host's build check lands in the check set of its own platform.
        // nixpkgs.lib.concatMapAttrs (
          hostName: configuration:
          nixpkgs.lib.optionalAttrs (
            configuration.pkgs.stdenv.hostPlatform.system == pkgs.stdenv.hostPlatform.system
          ) { "nixos-${hostName}" = configuration.config.system.build.toplevel; }
        ) self.nixosConfigurations
      );

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = with pkgs; [
            deadnix
            nixd
            nixfmt
            statix
          ];
        };
      });

      formatter = forAllSystems (pkgs: pkgs.nixfmt);
    };
}

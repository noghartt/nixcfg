{
  description = "All-in-one NixOS, nix-darwin, and home-manager configuration";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";

    # Darwin packages track the branch tested on macOS.
    nixpkgs-darwin.url = "github:nixos/nixpkgs/nixpkgs-unstable";

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

    nix-darwin = {
      url = "github:nix-darwin/nix-darwin/master";
      inputs.nixpkgs.follows = "nixpkgs-darwin";
    };

    # Declarative Homebrew installation on Darwin hosts; casks themselves are
    # declared through nix-darwin's `homebrew` module (see hosts/common/darwin).
    # No `follows`: its only input is the pinned Homebrew/brew source tree.
    nix-homebrew.url = "github:zhaofengli/nix-homebrew";

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

    # Full VS Code Marketplace as Nix packages (home/noghartt/features/vscode).
    # No `follows`: its per-system extension sets are prebuilt against its own
    # pin, and this flake has two nixpkgs branches to choose between anyway.
    nix-vscode-extensions.url = "github:nix-community/nix-vscode-extensions";

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

      hostFiles = nixpkgs.lib.filterAttrs (name: _: name != "common") (
        libEx.mapDir (hostName: ./hosts/${hostName}) ./hosts
      );
    in
    {
      # Custom option-only modules, auto-imported everywhere.
      nixosModules = import ./modules/nixos;
      homeManagerModules = import ./modules/home-manager;

      # User factories (home/<user>/user.nix), auto-discovered. Host specs
      # pick from these via their `users` field, optionally with per-host
      # overrides through either system constructor.
      users = libEx.mapDir (username: import ./home/${username}/user.nix) ./home;

      # Every top-level host directory except common/ is a host; a spec that
      # declares a *-darwin nixpkgs.hostPlatform is built with mkDarwinConfig,
      # everything else with mkNixOSConfig.
      nixosConfigurations = builtins.mapAttrs (
        hostName: hostFile: libEx.mkNixOSConfig { inherit hostName hostFile; }
      ) (nixpkgs.lib.filterAttrs (_: hostFile: !libEx.isDarwinHost hostFile) hostFiles);

      darwinConfigurations = builtins.mapAttrs (
        hostName: hostFile: libEx.mkDarwinConfig { inherit hostName hostFile; }
      ) (nixpkgs.lib.filterAttrs (_: hostFile: libEx.isDarwinHost hostFile) hostFiles);

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
        // nixpkgs.lib.concatMapAttrs (
          hostName: configuration:
          nixpkgs.lib.optionalAttrs (
            configuration.pkgs.stdenv.hostPlatform.system == pkgs.stdenv.hostPlatform.system
          ) { "darwin-${hostName}" = configuration.system; }
        ) self.darwinConfigurations
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

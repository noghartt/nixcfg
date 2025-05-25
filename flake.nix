{
  description = "Nix configuration";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs";

    nix-darwin.url = "github:lnl7/nix-darwin/master";
    nix-darwin.inputs.nixpkgs.follows = "nixpkgs";

    home-manager.url = "github:nix-community/home-manager";
    home-manager.inputs.nixpkgs.follows = "nixpkgs";

    flake-utils.url = "github:numtide/flake-utils";

    # TODO: It's having an error with substituteAll function on nix-darwin input
    # nix-homebrew.url = "github:zhaofengli-wip/nix-homebrew";
    # nix-homebrew.inputs.nixpkgs.follows = "nixpkgs";
    # nix-homebrew.inputs.nix-darwin.follows = "nix-darwin";

    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = inputs @ { self, flake-utils, nixpkgs, rust-overlay, ... }: let
    overlays = [ (import rust-overlay) (import ./nix/overlays) ];

    nixpkgsConfig = {
      inherit overlays;

      config.allowUnfree = true;
    };
  in {
    darwinConfigurations =
      let
        inherit (inputs.nix-darwin.lib) darwinSystem;
      in {
        "MacBook-Pro-de-Guilherme" = darwinSystem {
          system = "aarch64-darwin";

          specialArgs = { inherit inputs; };

          modules = [
            # inputs.nix-homebrew.darwinModules.nix-homebrew
            inputs.home-manager.darwinModules.home-manager
            ./nix/hosts/mbp/configuration.nix
            {
              nixpkgs = nixpkgsConfig;

              home-manager.useGlobalPkgs = true;
              home-manager.useUserPackages = true;
              home-manager.users.noghartt = import ./nix/home/home.nix;
            }
          ];
        };
      };
  } // flake-utils.lib.eachDefaultSystem (system:
    let
      pkgs = import nixpkgs { inherit system overlays; };
    in
    {
      packages = pkgs;

      devShell = with pkgs; mkShell {
        buildInputs = [
          nil
          statix
          nixpkgs-fmt
          rust-bin.beta.latest.default
          nodejs_22
        ];
      };
    }
  );
}

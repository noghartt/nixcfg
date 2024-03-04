{
  description = "My Nix configuration for all my hosts";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs";
    
    nixpkgs-unstable.url = "github:NixOs/nixpkgs/nixpkgs-unstable";

    nix-darwin.url = "github:lnl7/nix-darwin/master";
    nix-darwin.inputs.nixpkgs.follows = "nixpkgs";

    home-manager.url = "github:nix-community/home-manager";
    home-manager.inputs.nixpkgs.follows = "nixpkgs";

    nix-homebrew.url = "github:zhaofengli/nix-homebrew";
    homebrew-core = {
      url = "github:homebrew/homebrew-core";
      flake = false;
    };
    homebrew-cask = {
      url = "github:homebrew/homebrew-cask";
      flake = false;
    };
    homebrew-bundle = {
      url = "github:homebrew/homebrew-bundle";
      flake = false;
    };
  };

  outputs = inputs @ { self, ... }: let

    nixpkgsConfig = {
      config.allowUnfree = true;
    };
  in {
    darwinConfigurations = let
      inherit (inputs.nix-darwin.lib) darwinSystem;
      inherit (inputs.nix-homebrew.darwinModules) nix-homebrew;
      inherit (inputs.home-manager.darwinModules) home-manager;
    in {
      Guilhermes-MacBook-Pro-4 = darwinSystem {
        system = "aarch64-darwin";

        specialArgs = { inherit inputs; };

        modules = [
          nix-homebrew
          ./hosts/mbp/configuration.nix
          home-manager
          {
            nixpkgs = nixpkgsConfig;
            
            home-manager.useGlobalPkgs = true;
            home-manager.useUserPackages = true;
            home-manager.users.noghartt = import ./home/home.nix;
          }
        ];
      };
    };
  };
}

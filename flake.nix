{
  description = "Nix configuration";
 
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs";
 
    nix-darwin.url = "github:lnl7/nix-darwin/master";
    nix-darwin.inputs.nixpkgs.follows = "nixpkgs";
 
    home-manager.url = "github:nix-community/home-manager";
    home-manager.inputs.nixpkgs.follows = "nixpkgs";
  };
 
  outputs = inputs @ { self, ... }: let
    nixpkgsConfig = {
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
            ./hosts/mbp/configuration.nix
            inputs.home-manager.darwinModules.home-manager
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

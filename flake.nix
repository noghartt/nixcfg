{
  description = "My NixOS configuration";

  inputs = {
    flake-utils.url = "github:numtide/flake-utils";
    nur.url = "github:nix-community/NUR";
    nixpkgs = {
      url = "github:NixOS/nixpkgs/nixos-unstable";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    nixos-hardware = {
      url = "github:NixOS/nixos-hardware";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    home-manager = {
      url = "home-manager/release-21.11";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, home-manager, ... }@inputs:
    let
      overlays = with inputs; [
        nur.overlay
      ];
      lib = import ./lib { inherit inputs overlays; };
      inherit (home-manager.lib) homeManagerConfiguration;
    in
      {
        nixosConfigurations = {
          thinkpad = lib.mkHost {
            hostname = "thinkpad";
            users = [ "noghartt" ];
          };
        };
        homeConfigurations = {};
      };
}

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
      system = builtins.currentSystem;
      overlays = with inputs; [
        nur.overlay
      ];
      # TODO: Is necessary this `config.allowUnfree` here? Or just the
      # nixpkgs.config.allowUnfree, from home-manager, can be necessary?
      pkgs = import inputs.nixpkgs { 
        inherit system; 
        config = { allowUnfree = true; };
      };
      lib = import ./lib { inherit inputs overlays pkgs; };
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
        # TODO: I don't know why is necessary this shell here, but I see in a config
        # and I like it, so I'm adding here as well.
        #
        # I need to remember to ask why they did it. =)
        devShell = pkgs.mkShell {
          buildInputs = with pkgs; [ nixfmt rnix-lsp home-manager git ];
        };
      };
}

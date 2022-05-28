{
  description = "My NixOS configuration";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";

    nur.url = "github:nix-community/NUR";

    flake-utils.url = "github:numtide/flake-utils";

    nixos-hardware = {
      url = "github:NixOS/nixos-hardware";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    home-manager = {
      url = "github:nix-community/home-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    emacs-overlay.url = "github:nix-community/emacs-overlay";

    doom-emacs = {
      url = "github:nix-community/nix-doom-emacs";
      inputs.nixpkgs.follows = "nixpkgs";
      inputs.emacs-overlay.follows = "emacs-overlay";
    };
  };

  outputs = inputs@{ nixpkgs, flake-utils, ... }:
    let
      overlays = with inputs; [ nur.overlay emacs-overlay.overlay ];

      lib = import ./lib { inherit inputs overlays; };
    in {
      inherit overlays;

      nixosConfigurations = {
        thinkpad = lib.mkHost {
          hostname = "thinkpad";
          users = [ "noghartt" ];
        };
      };

      templates = import ./templates;
    } // flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system overlays; };

        ghcWithPackages = pkgs.ghc.withPackages (haskellPackages:
          with haskellPackages; [
            hlint
            haskell-language-server
          ]);
      in {
        packages = pkgs;

        devShell = pkgs.mkShell {
          buildInputs = with pkgs; [
            rnix-lsp
            statix
            nix-linter
            nixpkgs-fmt

            ghcWithPackages
          ];
        };
      });
}

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

  outputs = { ... }@inputs:
    let
      system = builtins.currentSystem or "x86_64-linux";

      overlays = with inputs; [
        nur.overlay
        emacs-overlay.overlay
      ];

      # TODO: Is necessary this `config.allowUnfree` here? Or just the
      # nixpkgs.config.allowUnfree, from home-manager, can be necessary?
      pkgs = import inputs.nixpkgs {
        inherit system overlays;
        config = { allowUnfree = true; };
      };

      lib = pkgs.callPackage ./lib { inherit inputs overlays; };
    in
    {
      inherit overlays;

      package = pkgs;

      nixosConfigurations = {
        thinkpad = lib.mkHost {
          hostname = "thinkpad";
          users = [ "noghartt" ];
        };
      };

      homeConfigurations = {
        "noghartt@thinkpad" = lib.mkHome {
          inherit system;
          username = "noghartt";
          hostname = "thinkpad";
        };
      };

      devShell.${system} = pkgs.mkShell {
        uildInputs = with pkgs; [ nixfmt rnix-lsp home-manager git ];
      };

      devShells.${system} = {
        node = pkgs.mkShell {
          buildInputs = with pkgs; [
            nodejs
            yarn
            python
          ];
        };
      };

      templates = import ./templates;
    };
}

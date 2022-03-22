{
  description = "My NixOS configuration";

  inputs = {
    flake-utils.url = "github:numtide/flake-utils";

    nur.url = "github:nix-community/NUR";

    nixpkgs = {
      url = "github:NixOS/nixpkgs/nixos-unstable";
    };

    nixos-hardware = {
      url = "github:NixOS/nixos-hardware";
      inputs.nixpkgs.follows = "nixpkgs";
    };

    home-manager = {
      url = "github:nix-community/home-manager";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { self, home-manager, ... }@inputs:
    let
      system = builtins.currentSystem or "x86_64-linux";

      overlays = with inputs; [
        nur.overlay
      ];

      # TODO: Is necessary this `config.allowUnfree` here? Or just the
      # nixpkgs.config.allowUnfree, from home-manager, can be necessary?
      pkgs = import inputs.nixpkgs { 
        inherit system; 
        config = { allowUnfree = true; };
      };

      lib = pkgs.callPackages ./lib { inherit inputs; };
    in
      {
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

        # TODO: I don't know why is necessary this shell here, but I see in a config
        # and I like it, so I'm adding here as well.
        #
        # I need to remember to ask why they did it. =)
        devShell.${system} = pkgs.mkShell {
          buildInputs = with pkgs; [ nixfmt rnix-lsp home-manager git ];
        };
      };
}

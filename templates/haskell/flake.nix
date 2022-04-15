{
  description = "Haskell Template project";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    flake-utils = {
      url = "github:numtide/flake-utils";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = inputs@{ nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        projectName = "haskell-template";

        overlay = final: prev: {
          ${projectName} = final.haskellPackages.callCabal2nix projectName ./. {  };
        };

        overlays = [ overlay ];

        pkgs = import nixpkgs { inherit system overlays; };
      in
      rec {
        # Necessary to execute `nix build`
        packages.${projectName} = pkgs.${projectName};

        defaultPackage = packages.${projectName};

        # Necessary to execute `nix run`
        apps.${projectName} = flake-utils.lib.mkApp { drv = packages.${projectName}; };

        defaultApp = apps.${projectName};

        # Necesary to execute `nix develop`
        devShell = pkgs.mkShell {
          inputsFrom = [ defaultPackage ];

          buildInputs = with pkgs; [
            haskell-language-server
            cabal-install
            ghc
          ];
        };
      }
    );
}

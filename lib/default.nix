{ inputs, overlays ? [  ] }:

let
  inherit (inputs) nixpkgs home-manager;
in
{
  mkHost = { hostname, system ? "x86_64-linux", users ? [  ] }:
    nixpkgs.lib.nixosSystem {
      inherit system;

      specialArgs = {
        inherit inputs system hostname;
      };

      modules = [
        home-manager.nixosModule

        ../hosts/${hostname}
        {
          networking.hostName = hostname;
         
          nixpkgs = {
            inherit overlays;
            config.allowUnfree = true;
          };

          home-manager = {
            useGlobalPkgs = true;
            useUserPackages = true;

            sharedModules = [
              inputs.doom-emacs.hmModule
            ];
          };
        }
      ] ++ nixpkgs.lib.forEach users (user: ../users/${user});
    };
}

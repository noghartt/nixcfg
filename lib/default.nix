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

  # mkHome = { username, system, hostname }:
  #   home-manager.lib.homeManagerConfiguration {
  #     inherit username system;

  #     extraSpecialArgs = {
  #       inherit system username hostname inputs;
  #     };

  #     homeDirectory = "/home/${username}";
  #     configuration = ../users/${username}/home/home.nix;
  #     stateVersion = "21.11";
  #     extraModules = [
  #       {
  #         nixpkgs = {
  #           inherit overlays;
  #           config.allowUnfree = true;
  #         };

  #         programs.home-manager.enable = true;
  #       }
  #     ];
  #   };
}

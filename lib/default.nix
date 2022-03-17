{ inputs, overlays ? [  ] }:

let
  inherit (inputs.nixpkgs) lib;
in
{
  # TODO: Change the system default value to `builtins.currentSystem`
  mkSystem = { hostname, system ? "x86_64-linux", users ? [  ] }:
    lib.nixosSystem {
      inherit system;
      specialArgs = {
        inherit inputs system hostname;
      };
      modules = [
        ../systems/${hostname}
        {
          networking.hostName = hostname;
          nixpkgs = {
            inherit overlays;
            config.allowUnfree = true;
          };
        }
      ] ++ lib.forEach users (user: ../users/${user});
    };
}

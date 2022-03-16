{ inputs, overlays }:

let
  inherit (inputs.nixpkgs) lib;
in
{
  mkSystem = { hostname, system ? builtins.currentSystem, users ? [  ] }:
    lib.nixosSystem {
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

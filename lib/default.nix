{ inputs, overlays ? [  ], pkgs }:

let
  inherit (inputs.nixpkgs) lib;
in
{
  # The `builtins.currentSystem` here is a mutable value, so you need to add
  # `--impure` flag in some cases.
  #
  # E.g.: nix flake check --impure
  #
  # TODO: This should be an impure value? Or we can add a default string value?
  # `"x86_64-linux"` for example.
  mkHost = { hostname, system ? builtins.currentSystem, users ? [  ] }:
    lib.nixosSystem {
      inherit system;
      specialArgs = {
        inherit inputs system hostname;
      };
      modules = [
        ../hosts/${hostname}
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

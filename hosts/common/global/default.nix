# Imported by every host.
{ flake, ... }:
{
  imports = [
    ./generation.nix
    ./nix.nix
    ./home-manager.nix
  ];

  nixpkgs.overlays = [ flake.outputs.overlays.codex ];
}

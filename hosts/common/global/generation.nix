{ flake, ... }:
let
  revision = flake.rev or (flake.dirtyRev or "dirty");
  shortRevision = flake.shortRev or (flake.dirtyShortRev or "dirty");
in
{
  system = {
    configurationRevision = revision;
    nixos.label = shortRevision;
  };

  # Immutable snapshots make the active generation self-describing in recovery.
  environment.etc = {
    nixcfg.source = flake.outPath;
    nixpkgs.source = flake.inputs.nixpkgs.outPath;
  };
}

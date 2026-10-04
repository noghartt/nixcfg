# OmO-only extension packages: every subdirectory holding a package.json.
# They hook OmO's engine internals or features Pi lacks, so they stay out of
# Pi's package list; OmO's settings baseline appends them to Pi's.
{ lib, pkgs }:
lib.mapAttrsToList
  (
    name: _:
    pkgs.stdenvNoCC.mkDerivation {
      pname = "omo-${name}";
      version = "1.0.0";
      src = ./${name};
      installPhase = ''
        runHook preInstall
        cp -r . "$out"
        runHook postInstall
      '';
    }
  )
  (
    lib.filterAttrs (name: type: type == "directory" && builtins.pathExists ./${name}/package.json) (
      builtins.readDir ./.
    )
  )

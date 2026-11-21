# OmO-only extension packages: every subdirectory holding a package.json.
# They hook OmO's engine internals or features Pi lacks, so they stay out of
# Pi's package list; OmO's settings baseline appends them to Pi's.
#
# A package that patches OmO internals records the OmO release it was checked
# against as `omoVerified` in its package.json; evaluation warns when the
# pinned OmO moves past it, so a bump cannot silently break the UI hooks.
{
  lib,
  pkgs,
  omoVersion,
}:
lib.mapAttrsToList
  (
    name: _:
    let
      manifest = builtins.fromJSON (builtins.readFile ./${name}/package.json);
    in
    lib.warnIf (manifest ? omoVerified && manifest.omoVerified != omoVersion)
      "omo-${name}: verified against OmO ${manifest.omoVerified}, pinned ${omoVersion}; recheck its host internals and bump omoVerified"
      (
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
  )
  (
    lib.filterAttrs (name: type: type == "directory" && builtins.pathExists ./${name}/package.json) (
      builtins.readDir ./.
    )
  )

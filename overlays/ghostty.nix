# Ghostty 1.4.0 reached nixpkgs-unstable before the locked nixpkgs-darwin; this keeps the
# Macs on it without moving the whole Darwin userspace, and steps aside once the lock catches up.
_: prev:
let
  version = "1.4.0";
in
{
  ghostty-bin =
    if prev.lib.versionOlder prev.ghostty-bin.version version then
      prev.ghostty-bin.overrideAttrs (_: {
        inherit version;
        src = prev.fetchurl {
          url = "https://release.files.ghostty.org/${version}/Ghostty.dmg";
          hash = "sha256-OgIHXb0kMY13hCavQd7lUH1T7MRXjt6WkS7Jzm0Y0+g=";
        };
      })
    else
      prev.ghostty-bin;
}

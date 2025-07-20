{
  lib,
  stdenv,
  callPackage,
  unrarSupport ? false
}:

let
  pname = "ghostty";

  version = "1.1.3";

  meta = with lib; {
    homepage = "https://ghostty.org";
    description = "Ghostty is a fast, feature-rich, and cross-platform terminal emulator that uses platform-native UI and GPU acceleration.";
    longDescription = ''
      Ghostty is a terminal emulator that differentiates itself by being fast, feature-rich, and native.
      While there are many excellent terminal emulators available, they all force you to choose between speed, features, or native UIs.
      Ghostty provides all three.
    '';
    changelog = "https://ghostty.org/docs/install/release-notes";
    maintainers = with maintainers; [ noghartt ];
    platforms = platforms.unix ++ platforms.darwin;
    mainProgram = "ghostty";
  };
in
if stdenv.hostPlatform.isDarwin then
  callPackage ./darwin.nix { inherit pname version meta; }
else
  callPackage ./linux.nix { inherit pname version meta; }

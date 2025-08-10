{
  pname,
  version,
  meta,
  stdenv,
  fetchurl,
  _7zz,
}:

stdenv.mkDerivation rec {
  inherit pname version meta;

  src = fetchurl {
    url = "https://release.files.ghostty.org/${version}/Ghostty.dmg";
    hash = "sha256-ZOUUGI9UlZjxZtbctvjfKfMz6VTigXKikB6piKFPJkc=";
  };

  sourceRoot = ".";

  nativeBuildInputs = [ _7zz ];

  dontConfigure = true;
  dontBuild = true;
  dontFixup = true; # breaks notarization

  phases = [
    "unpackPhase"
    "installPhase"
  ];

  unpackPhase = ''
    7zz x -snld $src
  '';

  installPhase = ''
    mkdir -p $out/Applications
    mv Ghostty.app $out/Applications

    # Create symlink to the Ghostty binary
    mkdir -p $out/bin
    ln -s $out/Applications/Ghostty.app/Contents/MacOS/ghostty $out/bin/ghostty

    # Create a copy of the Ghostty completion for fish
    mkdir -p $out/share/fish/vendor_completions.d
    cp $out/Applications/Ghostty.app/Contents/Resources/fish/vendor_completions.d/ghostty.fish $out/share/fish/vendor_completions.d/ghostty.fish
    # Create a copy of the Ghostty completion for zsh
    mkdir -p $out/share/zsh/site-functions
    cp $out/Applications/Ghostty.app/Contents/Resources/zsh/site-functions/_ghostty $out/share/zsh/site-functions/_ghostty

    # Set up man pages
    mkdir -p $out/share/man/man1
    mkdir -p $out/share/man/man5
    cp $out/Applications/Ghostty.app/Contents/Resources/man/man1/ghostty.1 $out/share/man/man1/
    cp $out/Applications/Ghostty.app/Contents/Resources/man/man5/ghostty.5 $out/share/man/man5/
  '';
}

{ lib, ... }:
{
  programs.ghostty = {
    enable = true;
    # Hosts provide the package when nixpkgs supports their platform.
    package = lib.mkDefault null;
    settings = {
      keybind = [
        # Explicit CSI-u chords survive multiplexers and macOS Option-key text input.
        "alt+a=text:\\x1b[97;3u"
        "super+p=text:\\x1b[112;3u"
        "super+r=text:\\x1b[114;3u"
      ];
    };
  };
}

{ lib, ... }:
{
  programs.ghostty = {
    enable = true;
    # Hosts provide the package when nixpkgs supports their platform.
    package = lib.mkDefault null;
    settings = {
      keybind = [
        # tmux does not preserve Super reliably; send unambiguous CSI-u Alt chords instead.
        "super+p=text:\\x1b[112;3u"
        "super+r=text:\\x1b[114;3u"
      ];
    };
  };
}

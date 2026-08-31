{ lib, ... }:
{
  programs.ghostty = {
    enable = true;
    # Hosts provide the package when nixpkgs supports their platform.
    package = lib.mkDefault null;
    settings = {
      keybind = [
        "shift+enter=text:\\x1b\\r"
        # tmux does not preserve Super reliably; send Pi an unambiguous CSI-u Alt+P instead.
        "super+p=text:\\x1b[112;3u"
      ];
    };
  };
}

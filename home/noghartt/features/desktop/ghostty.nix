{ lib, ... }:
{
  programs.ghostty = {
    enable = true;
    # Hosts provide the package when nixpkgs supports their platform.
    package = lib.mkDefault null;
    settings = {
      keybind = "shift+enter=text:\\x1b\\r";
    };
  };
}

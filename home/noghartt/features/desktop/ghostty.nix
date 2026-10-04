{ lib, ... }:
{
  programs.ghostty = {
    enable = true;
    # Hosts provide the package when nixpkgs supports their platform.
    package = lib.mkDefault null;
    settings = {
      # Left Option sends Alt so every Alt chord reaches Herdr, Pi, and OmO instead of
      # composing macOS text; right Option still types special characters.
      macos-option-as-alt = "left";
      keybind = [
        # Cmd aliases for Herdr's Alt+P PR tree and Alt+R lazygit.
        "super+p=text:\\x1b[112;3u"
        "super+r=text:\\x1b[114;3u"
        # Ctrl+? is DEL (Backspace) in legacy encoding; send it as CSI-u Ctrl+"?".
        "ctrl+shift+slash=text:\\x1b[63;5u"
      ];
    };
  };
}

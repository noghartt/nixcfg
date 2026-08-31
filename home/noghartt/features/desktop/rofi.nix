{ pkgs, ... }:
{
  # Wayland support was merged into the main rofi package.
  programs.rofi = {
    enable = true;
    package = pkgs.rofi;
    modes = [
      "drun"
      "run"
      "recursivebrowser"
    ];
  };
}

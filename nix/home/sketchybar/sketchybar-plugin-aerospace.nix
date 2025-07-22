{ pkgs, ... }:

pkgs.writeShellApplication {
  name = "sketchybar-plugin-aerospace";
  runtimeInputs = [ pkgs.sketchybar ];

  text = ''
  #!/usr/bin/env bash
  if [ "''$1" = "''${FOCUSED_WORKSPACE:-"1"}" ]; then
      sketchybar --set "''$NAME" background.drawing=on
  else
      sketchybar --set "''$NAME" background.drawing=off
  fi
  '';
}

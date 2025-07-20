{ pkgs, ... }:

pkgs.writeShellApplication {
  name = "sketchybar-plugin-clock";
  runtimeInputs = [ pkgs.sketchybar ];

  text = ''
  #!/bin/sh
  sketchybar --set "$NAME" label="$(date '+%d/%m %H:%M')"
  '';
}

#!/usr/bin/env bash

# make sure it's executable with:
# chmod +x ~/.config/sketchybar/plugins/aerospace.sh

if [ "$1" = "$FOCUSED_WORKSPACE" ]; then
    /etc/profiles/per-user/noghartt/bin/sketchybar --set $NAME background.drawing=on
else
    /etc/profiles/per-user/noghartt/bin/sketchybar --set $NAME background.drawing=off
fi

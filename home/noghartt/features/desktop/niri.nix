# Niri session (hosts/mellon/desktop.nix) with the Noctalia shell and i3-style
# keys. Niri reloads this file live when it changes. No legacy NVIDIA env
# hacks: with the open kernel module (hosts/mellon/nvidia.nix) they are obsolete.
{
  lib,
  osConfig,
  pkgs,
  ...
}:
let
  # Niri only resizes the focused column, so this focuses each neighbour in
  # turn and returns focus to the original window. `niri-split N` spreads the
  # focused column and the next N-1 (borrowing from the left at the strip's
  # end) across the screen in equal widths; N=1 restores full width. With no
  # argument it toggles between full width and a two-way split.
  niriSplit = pkgs.writeShellApplication {
    name = "niri-split";
    runtimeInputs = [
      osConfig.programs.niri.package
      pkgs.jq
    ];
    text = ''
      focused=$(niri msg --json focused-window)
      if jq -e '. == null or .is_floating' <<<"$focused" >/dev/null; then exit 0; fi
      id=$(jq -r .id <<<"$focused")
      ws=$(jq -r .workspace_id <<<"$focused")
      col=$(jq -r '.layout.pos_in_scrolling_layout[0]' <<<"$focused")

      n=''${1:-toggle}
      if [ "$n" = toggle ]; then
        out=$(niri msg --json focused-output | jq -r .logical.width)
        if jq -e --argjson o "$out" '.layout.tile_size[0] > $o * 0.75' <<<"$focused" >/dev/null; then
          n=2
        else
          n=1
        fi
      fi
      if [ "$n" -le 1 ]; then
        niri msg action set-column-width 100%
        exit 0
      fi

      # One window id per tiled column of this workspace, left to right.
      mapfile -t ids < <(niri msg --json windows | jq -r --argjson ws "$ws" '
        [.[] | select(.workspace_id == $ws and (.is_floating | not))]
        | group_by(.layout.pos_in_scrolling_layout[0])
        | .[][0].id')
      start=$((col - 1))
      if [ $((start + n)) -gt ''${#ids[@]} ]; then start=$((''${#ids[@]} - n)); fi
      if [ "$start" -lt 0 ]; then start=0; fi

      width=$(jq -n --argjson n "$n" '100 / $n * 1000 | floor / 1000')
      for target in "''${ids[@]:start:n}"; do
        niri msg action focus-window --id "$target"
        niri msg action set-column-width "$width%"
      done
      niri msg action focus-window --id "$id"
    '';
  };
in
{
  # Noctalia's own polkit agent is off (noctalia.nix); this one is a plain
  # Qt app that works under any Wayland compositor.
  services.hyprpolkitagent.enable = true;

  # Standard Adwaita cursor for Niri, XWayland and GTK apps alike; without
  # a declared theme each toolkit falls back to its own default.
  home.pointerCursor = {
    enable = true;
    package = pkgs.adwaita-icon-theme;
    name = "Adwaita";
    size = 24;
    gtk.enable = true;
    x11.enable = true;
  };

  xdg.configFile."niri/config.kdl".text = ''
    input {
        keyboard {
            xkb {
                layout "us"
                variant "intl"
            }
        }
        // libinput's default adaptive profile scales the pointer with hand
        // speed, which reads as drift; flat maps motion 1:1.
        mouse {
            accel-profile "flat"
        }
        focus-follows-mouse
    }

    // Without a refresh rate niri takes the highest one at that resolution (75 Hz).
    output "HDMI-A-2" {
        mode "2560x1080"
        scale 1
    }

    cursor {
        xcursor-theme "Adwaita"
        xcursor-size 24
    }

    // Each new window fills the ultrawide on its own column; neighbours sit
    // off-screen on the strip until Mod+S splits the screen with them.
    // A column narrowed on its own (Mod+R, Mod+Minus) is centred when alone.
    layout {
        gaps 12
        always-center-single-column
        center-focused-column "on-overflow"
        preset-column-widths {
            proportion 0.33333
            proportion 0.5
            proportion 0.66667
            proportion 1.0
        }
        default-column-width { proportion 1.0; }

        // The default 4 px side bar vanishes in the overview, where a tabbed
        // column shows only its active tab. A top strip with one clickable
        // segment per tab shows how many tabs a column holds.
        tab-indicator {
            position "top"
            place-within-column
            width 8
            gap 4
            gaps-between-tabs 6
            hide-when-single-tab
        }
    }

    // Slightly larger than the 0.5 default so the strip stays readable.
    overview {
        zoom 0.6
    }

    prefer-no-csd
    hotkey-overlay {
        skip-at-startup
    }

    spawn-at-startup "noctalia"

    binds {
        Mod+Shift+Slash { show-hotkey-overlay; }
        Mod+Return { spawn "ghostty"; }
        Mod+Shift+Q { close-window; }
        Mod+D { spawn "noctalia" "msg" "panel-toggle" "launcher"; }
        Mod+F { fullscreen-window; }
        Mod+Shift+F { maximize-column; }
        Mod+Shift+Space { toggle-window-floating; }
        Mod+Ctrl+L allow-when-locked=true { spawn "noctalia" "msg" "session" "lock"; }
        Mod+Shift+E { spawn "noctalia" "msg" "panel-toggle" "session"; }
        Mod+B { spawn "noctalia" "msg" "panel-toggle" "control-center"; }
        Mod+O { toggle-overview; }

        // i3 keys j/k/l/; plus arrows: columns run left/right, windows stack up/down.
        Mod+J { focus-column-left; }
        Mod+K { focus-window-down; }
        Mod+L { focus-window-up; }
        Mod+Semicolon { focus-column-right; }
        Mod+Left { focus-column-left; }
        Mod+Down { focus-window-down; }
        Mod+Up { focus-window-up; }
        Mod+Right { focus-column-right; }
        Mod+Shift+J { move-column-left; }
        Mod+Shift+K { move-window-down; }
        Mod+Shift+L { move-window-up; }
        Mod+Shift+Semicolon { move-column-right; }
        Mod+Shift+Left { move-column-left; }
        Mod+Shift+Down { move-window-down; }
        Mod+Shift+Up { move-window-up; }
        Mod+Shift+Right { move-column-right; }
        // Super+Alt merges into / splits out of the neighbouring column.
        Mod+Alt+J { consume-or-expel-window-left; }
        Mod+Alt+Semicolon { consume-or-expel-window-right; }
        Mod+Alt+Left { consume-or-expel-window-left; }
        Mod+Alt+Right { consume-or-expel-window-right; }

        // Tabbed columns stand in for i3's tabbed containers.
        Mod+W { toggle-column-tabbed-display; }

        // Mod+S toggles full width / half and half with the next column;
        // Mod+Shift+S makes thirds, which still fit a terminal on 2560 px.
        Mod+S hotkey-overlay-title="Split with the next column / unsplit" { spawn "${lib.getExe niriSplit}"; }
        Mod+Shift+S hotkey-overlay-title="Split into thirds" { spawn "${lib.getExe niriSplit}" "3"; }
        Mod+R { switch-preset-column-width; }
        Mod+C { center-column; }
        Mod+Shift+C { center-visible-columns; }
        Mod+Ctrl+F { expand-column-to-available-width; }
        Mod+Minus { set-column-width "-10%"; }
        Mod+Equal { set-column-width "+10%"; }
        Mod+Shift+Minus { set-window-height "-10%"; }
        Mod+Shift+Equal { set-window-height "+10%"; }

        Mod+1 { focus-workspace 1; }
        Mod+2 { focus-workspace 2; }
        Mod+3 { focus-workspace 3; }
        Mod+4 { focus-workspace 4; }
        Mod+5 { focus-workspace 5; }
        Mod+6 { focus-workspace 6; }
        Mod+7 { focus-workspace 7; }
        Mod+8 { focus-workspace 8; }
        Mod+9 { focus-workspace 9; }
        Mod+0 { focus-workspace 10; }
        Mod+Shift+1 { move-column-to-workspace 1; }
        Mod+Shift+2 { move-column-to-workspace 2; }
        Mod+Shift+3 { move-column-to-workspace 3; }
        Mod+Shift+4 { move-column-to-workspace 4; }
        Mod+Shift+5 { move-column-to-workspace 5; }
        Mod+Shift+6 { move-column-to-workspace 6; }
        Mod+Shift+7 { move-column-to-workspace 7; }
        Mod+Shift+8 { move-column-to-workspace 8; }
        Mod+Shift+9 { move-column-to-workspace 9; }
        Mod+Shift+0 { move-column-to-workspace 10; }

        Print { screenshot; }

        XF86AudioRaiseVolume allow-when-locked=true { spawn "wpctl" "set-volume" "-l" "1" "@DEFAULT_AUDIO_SINK@" "5%+"; }
        XF86AudioLowerVolume allow-when-locked=true { spawn "wpctl" "set-volume" "@DEFAULT_AUDIO_SINK@" "5%-"; }
        XF86AudioMute allow-when-locked=true { spawn "wpctl" "set-mute" "@DEFAULT_AUDIO_SINK@" "toggle"; }
        XF86AudioMicMute allow-when-locked=true { spawn "wpctl" "set-mute" "@DEFAULT_AUDIO_SOURCE@" "toggle"; }

        Mod+Shift+Ctrl+E { quit; }
    }
  '';
}

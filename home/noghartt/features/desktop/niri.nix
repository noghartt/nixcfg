# Niri session (hosts/mellon/desktop.nix) with the Noctalia shell and i3-style
# keys. Niri reloads this file live when it changes. No legacy NVIDIA env
# hacks: with the open kernel module (hosts/mellon/nvidia.nix) they are obsolete.
{ pkgs, ... }:
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

    // Columns start at the strip's left edge by default, which on the ultrawide
    // leaves a lone window pinned left. A lone column (one window or a tabbed
    // stack) is centred; half-width defaults make two windows an even split.
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
        default-column-width { proportion 0.5; }
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

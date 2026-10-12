# Hyprland session. No legacy NVIDIA env hacks: with the open kernel module
# (see hosts/mellon/nvidia.nix) the old GBM/WLR workarounds are obsolete.
{ pkgs, ... }:
{
  services.hyprpolkitagent.enable = true;

  # Standard Adwaita cursor for Hyprland, XWayland and GTK apps alike; without
  # a declared theme each toolkit falls back to its own default.
  home.pointerCursor = {
    enable = true;
    package = pkgs.adwaita-icon-theme;
    name = "Adwaita";
    size = 24;
    gtk.enable = true;
    x11.enable = true;
    hyprcursor.enable = true;
  };

  wayland.windowManager.hyprland = {
    enable = true;
    configType = "lua";

    extraConfig = ''
      hl.monitor({
        output = "",
        mode = "preferred",
        position = "auto",
        scale = 1,
      })

      hl.config({
        input = {
          kb_layout = "us",
          kb_variant = "intl",
        },
      })

      hl.on("hyprland.start", function()
        hl.exec_cmd("noctalia")
      end)

      hl.bind("SUPER + Return", hl.dsp.exec_cmd("ghostty"))
      hl.bind("SUPER + SHIFT + Q", hl.dsp.window.close())
      hl.bind("SUPER + D", hl.dsp.exec_cmd("noctalia msg panel-toggle launcher"))
      hl.bind("SUPER + F", hl.dsp.window.fullscreen())
      hl.bind("SUPER + SHIFT + Space", hl.dsp.window.float({ action = "toggle" }))
      hl.bind("SUPER + CTRL + L", hl.dsp.exec_cmd("noctalia msg session lock"))
      hl.bind("SUPER + SHIFT + E", hl.dsp.exec_cmd("noctalia msg panel-toggle session"))
      hl.bind("SUPER + B", hl.dsp.exec_cmd("noctalia msg panel-toggle control-center"))

      -- i3 keys: j/k/l/; plus the arrows. Super focuses, Super+Shift moves,
      -- Super+Alt merges into the neighbouring tab group.
      local directions = {
        J = "left", K = "down", L = "up", semicolon = "right",
        left = "left", down = "down", up = "up", right = "right",
      }
      for key, dir in pairs(directions) do
        hl.bind("SUPER + " .. key, hl.dsp.focus({ direction = dir }))
        hl.bind("SUPER + SHIFT + " .. key, hl.dsp.window.move({ direction = dir }))
        hl.bind("SUPER + ALT + " .. key, hl.dsp.window.move({ into_group = dir }))
      end

      for i = 1, 10 do
        local key = i % 10
        hl.bind("SUPER + " .. key, hl.dsp.focus({ workspace = i }))
        hl.bind("SUPER + SHIFT + " .. key, hl.dsp.window.move({ workspace = i }))
      end

      hl.bind("SUPER + SHIFT + C", hl.dsp.exec_cmd("hyprctl reload"))
      hl.bind("Print", hl.dsp.exec_cmd("flameshot gui"))

      hl.bind(
        "XF86AudioRaiseVolume",
        hl.dsp.exec_cmd("wpctl set-volume -l 1 @DEFAULT_AUDIO_SINK@ 5%+"),
        { locked = true, repeating = true }
      )
      hl.bind(
        "XF86AudioLowerVolume",
        hl.dsp.exec_cmd("wpctl set-volume @DEFAULT_AUDIO_SINK@ 5%-"),
        { locked = true, repeating = true }
      )
      hl.bind(
        "XF86AudioMute",
        hl.dsp.exec_cmd("wpctl set-mute @DEFAULT_AUDIO_SINK@ toggle"),
        { locked = true }
      )
      hl.bind(
        "XF86AudioMicMute",
        hl.dsp.exec_cmd("wpctl set-mute @DEFAULT_AUDIO_SOURCE@ toggle"),
        { locked = true }
      )

      -- i3-style tree control on top of dwindle's binary split tree.
      hl.bind("SUPER + E", hl.dsp.layout("togglesplit"))
      hl.bind("SUPER + H", hl.dsp.layout("preselect r"))
      hl.bind("SUPER + V", hl.dsp.layout("preselect d"))

      -- Groups are Hyprland's tabbed containers.
      hl.bind("SUPER + W", hl.dsp.group.toggle())
      hl.bind("SUPER + Tab", hl.dsp.group.next())
      hl.bind("SUPER + SHIFT + Tab", hl.dsp.group.prev())
      hl.bind("SUPER + SHIFT + W", hl.dsp.window.move({ out_of_group = true }))

      local monocle = false
      hl.bind("SUPER + M", function()
        monocle = not monocle
        hl.config({ general = { layout = monocle and "monocle" or "dwindle" } })
      end)

      hl.bind("SUPER + mouse:272", hl.dsp.window.drag(), { mouse = true })
      hl.bind("SUPER + mouse:273", hl.dsp.window.resize(), { mouse = true })

      -- Shift keeps Super+R free and makes the modal resize mode, which
      -- swallows j/k/l/; until Escape, hard to enter by accident.
      hl.bind("SUPER + SHIFT + R", hl.dsp.submap("resize"))
      hl.define_submap("resize", function()
        hl.bind("J", hl.dsp.window.resize({ x = -20, y = 0, relative = true }), { repeating = true })
        hl.bind("K", hl.dsp.window.resize({ x = 0, y = 20, relative = true }), { repeating = true })
        hl.bind("L", hl.dsp.window.resize({ x = 0, y = -20, relative = true }), { repeating = true })
        hl.bind("semicolon", hl.dsp.window.resize({ x = 20, y = 0, relative = true }), { repeating = true })
        hl.bind("escape", hl.dsp.submap("reset"))
        hl.bind("return", hl.dsp.submap("reset"))
      end)

      hl.window_rule({
        name = "obsidian-workspace",
        match = { class = "^(obsidian)$" },
        workspace = 10,
      })
      hl.window_rule({
        name = "todoist-workspace",
        match = { class = "^(Todoist)$" },
        workspace = 10,
      })
    '';
  };
}

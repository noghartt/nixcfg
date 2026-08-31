# Hyprland session. No legacy NVIDIA env hacks: with the open kernel module
# (see hosts/mellon/nvidia.nix) the old GBM/WLR workarounds are obsolete.
{
  services.hyprpolkitagent.enable = true;

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
      hl.bind("SUPER + D", hl.dsp.exec_cmd("rofi -show drun"))
      hl.bind("SUPER + F", hl.dsp.window.fullscreen())
      hl.bind("SUPER + SHIFT + Space", hl.dsp.window.float({ action = "toggle" }))
      hl.bind("SUPER + CTRL + L", hl.dsp.exec_cmd("noctalia msg session lock"))
      hl.bind("SUPER + SHIFT + E", hl.dsp.exec_cmd("noctalia msg panel-toggle session"))
      hl.bind("SUPER + B", hl.dsp.exec_cmd("noctalia msg panel-toggle control-center"))

      hl.bind("SUPER + J", hl.dsp.focus({ direction = "left" }))
      hl.bind("SUPER + K", hl.dsp.focus({ direction = "down" }))
      hl.bind("SUPER + L", hl.dsp.focus({ direction = "up" }))
      hl.bind("SUPER + semicolon", hl.dsp.focus({ direction = "right" }))
      hl.bind("SUPER + left", hl.dsp.focus({ direction = "left" }))
      hl.bind("SUPER + down", hl.dsp.focus({ direction = "down" }))
      hl.bind("SUPER + up", hl.dsp.focus({ direction = "up" }))
      hl.bind("SUPER + right", hl.dsp.focus({ direction = "right" }))

      hl.bind("SUPER + SHIFT + J", hl.dsp.window.move({ direction = "left" }))
      hl.bind("SUPER + SHIFT + K", hl.dsp.window.move({ direction = "down" }))
      hl.bind("SUPER + SHIFT + L", hl.dsp.window.move({ direction = "up" }))
      hl.bind("SUPER + SHIFT + semicolon", hl.dsp.window.move({ direction = "right" }))
      hl.bind("SUPER + SHIFT + left", hl.dsp.window.move({ direction = "left" }))
      hl.bind("SUPER + SHIFT + down", hl.dsp.window.move({ direction = "down" }))
      hl.bind("SUPER + SHIFT + up", hl.dsp.window.move({ direction = "up" }))
      hl.bind("SUPER + SHIFT + right", hl.dsp.window.move({ direction = "right" }))

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

      hl.bind("SUPER + mouse:272", hl.dsp.window.drag(), { mouse = true })
      hl.bind("SUPER + mouse:273", hl.dsp.window.resize(), { mouse = true })

      hl.bind("SUPER + R", hl.dsp.submap("resize"))
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

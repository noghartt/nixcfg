# Notification daemon, ported from the pre-NixOS dunstrc (template noise
# and Arch-specific paths dropped; behavior and colors kept).
{
  services.dunst = {
    enable = true;
    settings = {
      global = {
        monitor = 0;
        follow = "none";
        width = 300;
        height = "(0, 300)";
        origin = "top-right";
        offset = "(10, 50)";
        notification_limit = 20;
        progress_bar = true;
        progress_bar_height = 10;
        progress_bar_frame_width = 1;
        progress_bar_min_width = 150;
        progress_bar_max_width = 300;
        indicate_hidden = "yes";
        separator_height = 2;
        padding = 8;
        horizontal_padding = 8;
        frame_width = 3;
        frame_color = "#aaaaaa";
        font = "Monospace 8";
        markup = "full";
        format = "<b>%s</b>\\n%b";
        alignment = "left";
        vertical_alignment = "center";
        show_age_threshold = 60;
        ellipsize = "middle";
        stack_duplicates = true;
        hide_duplicate_count = false;
        show_indicators = "yes";
        enable_recursive_icon_lookup = true;
        icon_theme = "Adwaita";
        icon_position = "left";
        min_icon_size = 32;
        max_icon_size = 128;
        sticky_history = "yes";
        history_length = 20;
        always_run_script = true;
        mouse_left_click = "close_current";
        mouse_middle_click = "do_action, close_current";
        mouse_right_click = "close_all";
      };

      urgency_low = {
        background = "#222222";
        foreground = "#888888";
        timeout = 10;
      };

      urgency_normal = {
        background = "#285577";
        foreground = "#ffffff";
        timeout = 10;
        override_pause_level = 30;
      };

      urgency_critical = {
        background = "#900000";
        foreground = "#ffffff";
        frame_color = "#ff0000";
        timeout = 0;
        override_pause_level = 60;
      };
    };
  };
}

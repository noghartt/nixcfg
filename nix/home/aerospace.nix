_:

{
  programs.aerospace = {
    enable = true;

    userSettings = {
      start-at-login = true;
      default-root-container-layout = "tiles";

      accordion-padding = 0;

      gaps = {
        inner.horizontal = 0;
        inner.vertical = 0;
        outer.left = 0;
        outer.right = 0;
        outer.top = [
          { monitor."LG HDR WFHD" = 40; }
          0
        ];
        outer.bottom = 0;
      };

      key-mapping = {
        preset = "qwerty";
      };

      mode.main.binding = {
        ctrl-alt-enter = "exec-and-forget open -na /Applications/Ghostty.app";

        alt-slash = "layout tiles horizontal vertical";
        alt-shift-slash = "layout accordion horizontal vertical";

        alt-shift-h = "move left";
        alt-shift-j = "move down";
        alt-shift-k = "move up";
        alt-shift-l = "move right";

        alt-1 = "workspace 1";
        alt-2 = "workspace 2";
        alt-3 = "workspace 3";
        alt-4 = "workspace 4";
        alt-5 = "workspace 5";
        alt-6 = "workspace 6";
        alt-7 = "workspace 7";
        alt-8 = "workspace 8";
        alt-9 = "workspace 9";

        alt-shift-1 = "move-node-to-workspace 1";
        alt-shift-2 = "move-node-to-workspace 2";
        alt-shift-3 = "move-node-to-workspace 3";
        alt-shift-4 = "move-node-to-workspace 4";
        alt-shift-5 = "move-node-to-workspace 5";
        alt-shift-6 = "move-node-to-workspace 6";
        alt-shift-7 = "move-node-to-workspace 7";
        alt-shift-8 = "move-node-to-workspace 8";
        alt-shift-9 = "move-node-to-workspace 9";

        alt-tab = "workspace-back-and-forth";

        alt-shift-semicolon =  "mode service";
      };

      mode.service.binding = {
        alt-shift-semicolon = "mode main";

        esc = [ "reload-config" "mode main" ];

        r = [ "flatten-workspace-tree" "mode main" ];
        f = [ "layout floating tiling" "mode main" ];

        alt-shift-h = [ "join-with left" "mode main" ];
        alt-shift-j = [ "join-with down" "mode main" ];
        alt-shift-k = [ "join-with up" "mode main" ];
        alt-shift-l = [ "join-with right" "mode main" ];
      };
    };
  };
}

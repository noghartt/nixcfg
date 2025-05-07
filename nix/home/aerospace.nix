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
        outer.top = 0;
        outer.bottom = 0;
      };

      mode.main.binding = {
        ctrl-alt-enter = "exec-and-forget open -na /Applications/Ghostty.app";
        alt-slash = "layout tiles horizontal vertical";
        alt-shift-slash = "layout accordion horizontal vertical";
      };
    };
  };
}

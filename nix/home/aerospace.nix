_:

{
  programs.aerospace = {
    enable = true;

    userSettings = {
      start-at-login = true;
      default-root-container-layout = "tiles";

      mode.main.binding = {
        ctrl-alt-enter = "exec-and-forget open -na /Applications/Ghostty.app";
        alt-slash = "layout tiles horizontal vertical";
        alt-shift-slash = "layout accordion horizontal vertical";
      };
    };
  };
}

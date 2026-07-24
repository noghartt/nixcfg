{
  flake,
  pkgs,
  ...
}:
{
  imports = [ flake.inputs.noctalia.homeModules.default ];

  programs.noctalia = {
    enable = true;
    package = flake.inputs.noctalia.packages.${pkgs.stdenv.hostPlatform.system}.default;

    settings = {
      shell = {
        telemetry_enabled = false;
        polkit_agent = false;
      };

      notification.enable_daemon = true;
      lockscreen.enabled = true;

      idle.behavior = {
        lock = {
          enabled = true;
          timeout = 600;
          action = "lock";
        };
        screen-off = {
          enabled = true;
          timeout = 660;
          action = "screen_off";
        };
      };

      theme = {
        mode = "dark";
        source = "builtin";
        builtin = "Catppuccin";
      };
    };
  };
}

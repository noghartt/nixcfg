{
  flake,
  lib,
  pkgs,
  ...
}:
let
  noctalia = flake.inputs.noctalia.packages.${pkgs.stdenv.hostPlatform.system}.default;
  lockNoctalia = pkgs.writeShellApplication {
    name = "lock-noctalia";
    runtimeInputs = [
      noctalia
      pkgs.coreutils
    ];
    text = ''
      marker="$XDG_RUNTIME_DIR/noctalia-session-locked"
      rm -f "$marker"
      noctalia msg session lock

      for _ in $(seq 1 100); do
        [ -e "$marker" ] && exit 0
        sleep 0.1
      done

      echo "Noctalia did not confirm the session lock" >&2
      exit 1
    '';
  };
in
{
  imports = [ flake.inputs.noctalia.homeModules.default ];

  programs.noctalia = {
    enable = true;
    package = noctalia;

    settings = {
      shell = {
        telemetry_enabled = false;
        polkit_agent = false;
      };

      notification.enable_daemon = true;
      lockscreen.enabled = true;

      idle = {
        behavior = {
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
      };

      hooks.session_locked = "touch $XDG_RUNTIME_DIR/noctalia-session-locked";

      theme = {
        mode = "dark";
        source = "builtin";
        builtin = "Catppuccin";
      };
    };
  };

  # systemd-lock-handler starts lock.target before suspend and hibernation.
  systemd.user.services.noctalia-lock = {
    Unit = {
      Description = "Lock Noctalia before sleep";
      Before = [ "lock.target" ];
      PartOf = [ "lock.target" ];
    };
    Service = {
      Type = "oneshot";
      ExecStart = lib.getExe lockNoctalia;
      TimeoutStartSec = 15;
    };
    Install.WantedBy = [ "lock.target" ];
  };
}

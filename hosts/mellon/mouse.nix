# Logitech mouse on a Logi Bolt receiver (046d:c548). Its sensitivity lives in
# the mouse, so libinput cannot raise it: Solaar writes it over HID++.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  dpi = "3200";
  setDpi = pkgs.writeShellApplication {
    name = "solaar-set-dpi";
    runtimeInputs = [ config.programs.solaar.package ];
    text = ''
      # The mouse's receiver slot depends on pairing order, and a mouse exposes
      # either the classic (dpi) or the extended (dpi_extended) DPI feature.
      # Empty slots and the other feature only log an error.
      for slot in 1 2 3 4 5 6; do
        if solaar config "$slot" dpi ${dpi}; then exit 0; fi
        if solaar config "$slot" dpi_extended X ${dpi}; then
          solaar config "$slot" dpi_extended Y ${dpi} || true
          exit 0
        fi
      done
      exit 1
    '';
  };
in
{
  programs.solaar = {
    enable = true;
    userService.enable = true;
  };

  # Without the daemon running, the CLI saves the value to Solaar's config,
  # which the daemon loads next and re-applies whenever the mouse reconnects or
  # wakes. A mouse asleep at login fails here ("-" keeps the daemon starting)
  # and keeps the value saved at an earlier login.
  systemd.user.services.solaar.serviceConfig.ExecStartPre = "-${lib.getExe setDpi}";
}

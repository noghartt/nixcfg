# Cua Driver: background computer use for the harnesses without a native tool
# (Pi, Claude Code, Codex). OmO keeps its own `computer` tool.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  cua-driver = pkgs.callPackage ./package.nix { };

  # TCC attribution, LaunchServices discovery (`open -a`, `permissions grant`)
  # and the CLI's relaunch-into-app check all key on upstream's install path,
  # so the app is copied out of the store instead of linked from it.
  appPath = "/Applications/CuaDriver.app";
  appBinary = "${appPath}/Contents/MacOS/cua-driver";

  env = {
    CUA_TELEMETRY = "0";
    # Updates come from bumping package.nix; the self-updater would replace
    # the pinned app with whatever release is latest.
    CUA_DRIVER_RS_UPDATE_CHECK = "false";
  };

  # Upstream links the CLI into the bundle, which is how the CLI detects it
  # runs as the permission-holding app.
  cli = pkgs.runCommandLocal "cua-driver-cli" { } ''
    mkdir -p $out/bin
    ln -s ${appBinary} $out/bin/cua-driver
  '';

  agentLabel = config.launchd.agents.cua-driver.config.Label;
in
{
  imports = [ ./agents.nix ];

  home = {
    packages = [ cli ];
    sessionVariables = env;

    activation.installCuaDriverApp =
      lib.hm.dag.entryBetween [ "setupLaunchAgents" ] [ "writeBoundary" ]
        ''
          src=${cua-driver}/Applications/CuaDriver.app
          dest=${lib.escapeShellArg appPath}

          if ! cmp -s "$src/Contents/MacOS/cua-driver" "$dest/Contents/MacOS/cua-driver"; then
            run rm -rf "$dest.nix-new"
            run cp -R "$src" "$dest.nix-new"
            run chmod -R u+w "$dest.nix-new"
            if [ -e "$dest" ]; then
              run chmod -R u+w "$dest"
              run rm -rf "$dest"
            fi
            run mv "$dest.nix-new" "$dest"
            run /usr/bin/codesign --verify --deep --strict "$dest"

            # launchd keeps the replaced binary running until the agent restarts.
            if /bin/launchctl print "gui/$(id -u)/${agentLabel}" >/dev/null 2>&1; then
              run /bin/launchctl kickstart -k "gui/$(id -u)/${agentLabel}"
            fi
          fi
        '';
  };

  # One-shot `cua-driver call` commands need a running daemon.
  launchd.agents.cua-driver = {
    enable = true;
    config = {
      ProgramArguments = [
        appBinary
        "serve"
      ];
      EnvironmentVariables = env;
      RunAtLoad = true;
      KeepAlive = true;
      ProcessType = "Interactive";
    };
  };
}

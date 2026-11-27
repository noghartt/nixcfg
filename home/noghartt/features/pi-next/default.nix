# The `pi` command, starting from an empty, hand-managed agent dir. Nix owns the
# binary and the extensions under ./extensions; settings, logins and any other
# extension live in the dir and are edited there. The dir is set in the wrapper
# rather than the session, so OmO never sees it and keeps using its own.
{
  config,
  lib,
  pkgs,
  agentPath,
  ...
}:
let
  agentDir = "${config.xdg.configHome}/pi/agent";

  withAgentDir =
    name: package:
    pkgs.writeShellScriptBin name ''
      export PI_CODING_AGENT_DIR="''${PI_CODING_AGENT_DIR:-${agentDir}}"
      exec -a ${name} ${agentPath.wrap package}/bin/${name} "$@"
    '';

  # Every subdirectory holding a package.json is linked into the agent dir's
  # discovered `extensions/`, one link per package, so hand-added siblings survive.
  extensions = lib.filterAttrs (
    name: type: type == "directory" && builtins.pathExists ./extensions/${name}/package.json
  ) (builtins.readDir ./extensions);
in
{
  home.packages = [ (withAgentDir "pi" pkgs.pi-coding-agent) ];

  xdg.configFile = lib.mapAttrs' (
    name: _: lib.nameValuePair "pi/agent/extensions/${name}" { source = ./extensions/${name}; }
  ) extensions;
}

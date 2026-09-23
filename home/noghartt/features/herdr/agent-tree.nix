{
  config,
  lib,
  pkgs,
  ...
}:
let
  agentTree = pkgs.writeShellApplication {
    name = "herdr-agent-tree";
    runtimeInputs = [
      config.programs.herdr.package
      pkgs.python3
    ];
    text = ''
      exec python3 ${./agent-tree.py} "$@"
    '';
  };
in
{
  home.packages = [ agentTree ];

  programs.herdr.settings.keys.command = [
    {
      key = "alt+a";
      type = "popup";
      command = lib.getExe agentTree;
      description = "navigate agents";
      width = "85%";
      height = "80%";
    }
  ];
}

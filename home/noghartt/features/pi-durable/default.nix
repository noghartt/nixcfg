# pi-durable: a durable coding agent (crash-safe sessions in SQLite) with pi's
# TUI pieces, sharing pi's agent dir: logins, settings, models, skills, prompt
# templates, AGENTS.md. Source in ./src; see docs/pi-durable.md.
{
  config,
  lib,
  pkgs,
  agentPath,
  ...
}:
let
  agentDir = "${config.xdg.configHome}/pi/agent";
  chrome = config.programs.google-chrome;
  durable = pkgs.callPackage ./package.nix {
    git-twig = pkgs.callPackage ../git-twig/package.nix { };
  };
  # A port checked against another Pi is left out with a warning instead of
  # failing the host's build.
  usable =
    lib.warnIf durable.meta.broken
      "pi-durable: checked against another Pi than ${pkgs.pi-coding-agent.version}; re-port home/noghartt/features/pi-durable (docs/pi-durable.md)"
      (!durable.meta.broken);
in
{
  home.packages = lib.optional usable (
    pkgs.writeShellScriptBin "pi-durable" ''
      export PI_CODING_AGENT_DIR="''${PI_CODING_AGENT_DIR:-${agentDir}}"
      ${lib.optionalString chrome.enable ''
        # web_fetch renders JavaScript pages in this Chrome, headless (docs/deep-research.md).
        export PI_DURABLE_CHROME="''${PI_DURABLE_CHROME:-${chrome.package}/bin/google-chrome-stable}"
      ''}
      exec -a pi-durable ${agentPath.wrap durable}/bin/pi-durable "$@"
    ''
  );

  # Subagent profiles, one link per file so hand-added profiles beside them survive.
  # The research skill drives pi-durable's own research tools and profiles
  # (docs/deep-research.md), so it ships here rather than in cli/agents/skills.nix.
  xdg.configFile =
    lib.mapAttrs' (
      name: _: lib.nameValuePair "pi/agent/agents/${name}" { source = ./agents/${name}; }
    ) (lib.filterAttrs (name: _: lib.hasSuffix ".md" name) (builtins.readDir ./agents))
    // {
      "pi/agent/skills/research".source = ./skills/research;
    };
}

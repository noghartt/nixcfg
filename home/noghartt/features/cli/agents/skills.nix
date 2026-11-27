# Skills shared by every harness: pinned third-party ones and our own
# (`skills/`). Pi's agent dir is hand-managed,
# so its copy is linked into `skills/` there, one link per skill, leaving
# hand-added siblings alone.
{ lib, pkgs, ... }:
let
  cursorPlugins = "41e400932eca14f289e7db717a70455256b6d388";

  skillFile =
    name: url: hash:
    pkgs.linkFarm name [
      {
        name = "SKILL.md";
        path = pkgs.fetchurl { inherit url hash; };
      }
    ];

  skills = {
    thermo-nuclear-code-quality-review =
      skillFile "thermo-nuclear-code-quality-review"
        "https://raw.githubusercontent.com/cursor/plugins/${cursorPlugins}/cursor-team-kit/skills/thermo-nuclear-code-quality-review/SKILL.md"
        "sha256-f6ygi1G2Q7Ld0INvkq8VV0REAkaF3MHmd9u7Oa6Mno8=";
    pr-babysit = ./skills/pr-babysit;
    rex-workflows = ./skills/rex-workflows;
  };
in
{
  programs = {
    claude-code.skills = skills;
    codex.skills = skills;
  };

  xdg.configFile = lib.mapAttrs' (
    name: source: lib.nameValuePair "pi/agent/skills/${name}" { inherit source; }
  ) skills;
}

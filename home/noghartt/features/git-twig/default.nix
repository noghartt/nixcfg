# git-twig: `git twig new` creates ordinary linked worktrees with APFS/reflink
# copy-on-write, so agent worktrees cost little disk. Not in nixpkgs yet.
# Its bundled skill goes to every harness, like cli/agents/skills.nix.
{ pkgs, ... }:
let
  git-twig = pkgs.callPackage ./package.nix { };
  skill = "${git-twig}/share/git-twig/skills/git-twig";
in
{
  home.packages = [ git-twig ];

  programs = {
    claude-code.skills.git-twig = skill;
    codex.skills.git-twig = skill;
  };
  xdg.configFile."pi/agent/skills/git-twig".source = skill;
}

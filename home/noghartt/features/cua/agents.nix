# Hands Cua Driver to the harnesses: the upstream skill for Pi, Claude Code and
# Codex, plus Cua's read-only docs-and-source MCP for the MCP-capable ones.
{ pkgs, ... }:
let
  inherit (pkgs.callPackage ./package.nix { }) skill;
  docsMcp = "https://vk-mcp.cua.ai/mcp";
in
{
  programs = {
    # OmO filters this back out of the Pi skills it inherits.
    pi-coding-agent.settings.skills = [ skill ];

    claude-code = {
      skills.cua-driver = skill;
      mcpServers.cua-docs = {
        type = "http";
        url = docsMcp;
      };
    };

    codex = {
      skills.cua-driver = skill;
      settings.mcp_servers.cua-docs.url = docsMcp;
    };
  };
}

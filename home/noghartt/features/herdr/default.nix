{ flake, pkgs, ... }:
{
  imports = [
    ./agent-tree.nix
    ./lazygit
    ./pr-tree
  ];

  programs.herdr = {
    enable = true;
    package = flake.inputs.herdr.packages.${pkgs.stdenv.hostPlatform.system}.default;
    settings = {
      # config.toml is a read-only store symlink, so Herdr can't persist
      # finishing onboarding itself; declaring it stops the first-run flow.
      onboarding = false;
      theme = {
        name = "catppuccin";
        auto_switch = false;
      };
      ui.agent_panel_sort = "priority";
      # Start agent panes fresh after a server restart instead of resuming
      # their previous Claude/Codex conversations.
      session.resume_agents_on_restore = false;
    };
  };

  # Replace Herdr's generated first-run config when adopting Home Manager.
  xdg.configFile."herdr/config.toml".force = true;
}

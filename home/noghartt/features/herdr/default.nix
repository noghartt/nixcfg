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
      theme = {
        name = "catppuccin";
        auto_switch = false;
      };
      ui.agent_panel_sort = "priority";
    };
  };

  # Replace Herdr's generated first-run config when adopting Home Manager.
  xdg.configFile."herdr/config.toml".force = true;
}

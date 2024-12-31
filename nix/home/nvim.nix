{ pkgs, ... }:

{
  programs.neovim = {
    enable = true;

    extraPackages = with pkgs; [
      tree-sitter

      nil
      nixpkgs-fmt
      statix

      ripgrep
      fd
    ];
  };

  xdg.configFile.nvim = {
    source = ../../neovim;
    recursive = true;
  };
}

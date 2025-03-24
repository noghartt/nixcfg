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

  home.sessionVariables = {
    NVIM_LISTEN_ADDRESS = "/tmp/nvim";
  };

  xdg.configFile.nvim = {
    source = ../../neovim;
    recursive = true;
  };
}

{ config, pkgs, ... }:
{
  programs.neovim = {
    enable = true;
    defaultEditor = true;
    viAlias = true;
    vimAlias = true;
    initLua = builtins.readFile ./init.lua;
    # Mason builds eslint-lsp and typescript-language-server with npm, gopls
    # with go, and basedpyright in a python3 venv; scoped to Neovim's PATH.
    extraPackages = with pkgs; [
      nodejs
      go
      python3
    ];
  };

  # Lazy builds native plugins and Treesitter parsers at runtime.
  home.packages = with pkgs; [
    gnumake
    ripgrep
    stdenv.cc
  ];

  # Lazy rewrites the lockfile on install/update, so it must stay writable:
  # out-of-store symlink into the repo (same pattern as the vscode feature),
  # assuming the flake checkout lives at ~/www/nixcfg.
  xdg.configFile."nvim/lazy-lock.json".source =
    config.lib.file.mkOutOfStoreSymlink "${config.home.homeDirectory}/www/nixcfg/config/neovim/lazy-lock.json";
}

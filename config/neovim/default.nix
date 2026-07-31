{ pkgs, ... }:
{
  programs.neovim = {
    enable = true;
    defaultEditor = true;
    viAlias = true;
    vimAlias = true;
    initLua = builtins.readFile ./init.lua;
  };

  # Lazy builds native plugins and Treesitter parsers at runtime.
  home.packages = with pkgs; [
    gnumake
    ripgrep
    stdenv.cc
  ];

  xdg.configFile."nvim/lazy-lock.json".source = ./lazy-lock.json;
}

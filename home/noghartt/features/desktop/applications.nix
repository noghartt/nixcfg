{ pkgs, ... }:
{
  home.packages = with pkgs; [
    calibre
    discord
    slack
    spotify
    todoist-electron
    zotero
  ];
}

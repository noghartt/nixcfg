{ pkgs, ... }:
{
  programs = {
    steam = {
      enable = true;
      # Proton-GE carries game fixes and media codecs ahead of Valve's
      # Proton; pick it per game under Properties > Compatibility.
      extraCompatPackages = [ pkgs.proton-ge-bin ];
    };
    gamemode.enable = true;
  };
}

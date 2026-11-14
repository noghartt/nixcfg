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
    # GT: New Horizons servers (2.7+) run on Java 21; Prism Launcher keeps
    # its own runtimes, so this JDK is for servers started from a shell.
    java = {
      enable = true;
      package = pkgs.jdk21;
    };
  };
}

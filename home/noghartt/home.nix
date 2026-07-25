# Portable home-manager baseline for this user, imported on every host.
# Desktop and platform composition lives in <host>.nix next to this file.
{
  imports = [
    ./features/cli
    ./features/pi
  ];

  programs.home-manager.enable = true;
}

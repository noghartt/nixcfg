# Default home-manager configuration for this user, imported on every
# host. Host-specific overrides live in <host>.nix next to this file.
{
  imports = [
    ./features/cli
    ./features/pi
  ];

  programs.home-manager.enable = true;
}

{ users, ... }:
{
  imports = [
    ../common/darwin
  ];

  users = [
    users.noghartt
  ];

  nixpkgs.hostPlatform = "aarch64-darwin";
  device.type = "laptop";

  # Apps unavailable or unsuitable through nixpkgs on Darwin.
  homebrew.casks = [
    "1password"
    "raycast"
    "slack"
  ];

  system = {
    primaryUser = "noghartt";
    stateVersion = 7;
  };
}

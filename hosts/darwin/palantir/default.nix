{ users, ... }:
{
  imports = [
    ../../common/darwin
  ];

  users = [
    users.noghartt
  ];

  nixpkgs.hostPlatform = "aarch64-darwin";
  device.type = "laptop";

  system = {
    primaryUser = "noghartt";
    stateVersion = 7;
  };
}

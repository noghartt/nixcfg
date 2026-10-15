{ users, ... }:
{
  imports = [
    ../common/darwin
    ../common/optional/macbook.nix
  ];

  users = [
    users.noghartt
  ];

  nixpkgs.hostPlatform = "aarch64-darwin";

  system.stateVersion = 7;
}

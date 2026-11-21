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

  homebrew.casks = [ "openvpn-connect" ];

  system.stateVersion = 7;
}

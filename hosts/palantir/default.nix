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

  # DeepSeek's official desktop app ships only as a cask; nixpkgs has just the
  # `dsh` CLI (features/cli/agents/deepseek-harness.nix), which shares ~/.dsh with it.
  homebrew.casks = [
    "deepseek-harness"
    "openvpn-connect"
  ];

  system.stateVersion = 7;
}

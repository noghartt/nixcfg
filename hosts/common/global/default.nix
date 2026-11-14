# Imported by every host.
{ flake, ... }:
{
  imports = [
    ./generation.nix
    ./nix.nix
    ./home-manager.nix
  ];

  nixpkgs.overlays = [
    flake.outputs.overlays.codex
    flake.outputs.overlays.pi
    # Linux-only: the vendor ships Grok Bot for Linux as a .deb alone.
    flake.outputs.overlays.grok-bot
    # Linux-only: Anthropic ships Claude Desktop for Linux as a .deb alone (Macs use the cask).
    flake.outputs.overlays.claude-desktop
  ];
}

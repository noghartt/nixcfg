{ pkgs, ... }:
{
  # `op` for working with the same 1Password vaults the opnix modules read
  # from (see git.nix and secrets-env.nix); the desktop app stays per-host.
  home.packages = [ pkgs._1password-cli ];
}

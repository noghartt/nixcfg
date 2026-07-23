# Dev tooling. The docker daemon itself is a system concern
# (hosts/mellon/docker.nix); this is the user-facing client side.
{ pkgs, ... }:
{
  home.packages = [ pkgs.docker-compose ];
}

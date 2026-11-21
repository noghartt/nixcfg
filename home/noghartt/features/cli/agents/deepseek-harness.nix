{ agentPath, pkgs, ... }:
let
  # nixpkgs lists Linux only, but the same recipe builds and runs on aarch64-darwin.
  dsh = pkgs.deepseek-harness.overrideAttrs (old: {
    meta = old.meta // {
      platforms = old.meta.platforms ++ [ "aarch64-darwin" ];
    };
  });
in
{
  home.packages = [ (agentPath.wrap dsh) ];
}

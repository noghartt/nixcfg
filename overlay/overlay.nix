self: super:
{
  manga-cli = self.callPackage ./manga-cli.nix { };
  gh-stars = self.callPackage ./gh-stars.nix { };
}
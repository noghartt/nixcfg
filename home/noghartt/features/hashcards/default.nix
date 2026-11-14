# hashcards: plain-text spaced repetition, not in nixpkgs yet. Decks and the
# review database stay wherever the user keeps their cards.
{ pkgs, ... }:
{
  home.packages = [ (pkgs.callPackage ./package.nix { }) ];
}

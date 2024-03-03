{ inputs, ... }:

let
  inherit (inputs) homebrew-core homebrew-cask homebrew-bundle;
in
{
  nix-homebrew = {
    autoMigrate = true;

    enable = true;
    enableRosetta = true;

    # TODO: Move this to dynamic username
    user = "noghartt";

    taps = {
      "homebrew/homebrew-core" = homebrew-core;
      "homebrew/homebrew-cask" = homebrew-cask;
      "homebrew/homebrew-bundle" = homebrew-bundle;
    };

    mutableTaps = false;
  };
}

{ config, flake, ... }:
{
  imports = [
    flake.inputs.nix-homebrew.darwinModules.nix-homebrew
  ];

  # nix-homebrew owns the Homebrew installation itself (pinned via flake.lock);
  # the nix-darwin homebrew module below only drives `brew bundle` over it.
  nix-homebrew = {
    enable = true;
    user = config.system.primaryUser;
  };

  homebrew = {
    enable = true;
    onActivation = {
      autoUpdate = false;
      upgrade = false;
      # Uninstall (and purge config of) anything not declared, so the set of
      # installed casks/formulae never drifts from the flake.
      cleanup = "zap";
    };
  };
}

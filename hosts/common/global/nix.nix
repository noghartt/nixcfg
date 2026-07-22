{ flake, lib, ... }:

{
  nix = {
    settings = {
      experimental-features = [
        "nix-command"
        "flakes"
      ];
      auto-optimise-store = true;
      trusted-users = [ "@wheel" ];
    };

    gc = {
      automatic = true;
      dates = "weekly";
      options = "--delete-older-than 30d";
    };

    # Pin flake inputs into the registry, so `nix shell nixpkgs#foo` runs
    # against the exact nixpkgs this system was built from.
    registry = lib.mapAttrs (_: input: { flake = input; }) (
      lib.filterAttrs (name: _: name != "self") flake.inputs
    );
  };

  nixpkgs.config.allowUnfree = true;
}

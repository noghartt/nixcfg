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

      # Collect garbage during a build once free space drops below 25 GiB,
      # up to 100 GiB free, so parallel agent builds cannot fill the disk
      # between weekly GCs. Adapted from github:fersilva16/nix-config.
      min-free = 25 * 1024 * 1024 * 1024;
      max-free = 100 * 1024 * 1024 * 1024;
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

{ pkgs, ... }:

{
  # TODO: Just this attribute is useful? Or I need to add the allowUnfree on `flake.nix` as well?
  nixpkgs.config.allowUnfree = true;

  nix = {
    package = pkgs.nixUnstable;

    settings = {
      trusted-users = [ "root" "@wheel" ];
      auto-optimise-store = true;
    };

    gc = {
      automatic = true;
      options = "--delete-older-than 15d";
    };

    extraOptions = ''
      experimental-features = nix-command flakes

      keep-derivations = true
      keep-outputs = true
    '';
  };
}

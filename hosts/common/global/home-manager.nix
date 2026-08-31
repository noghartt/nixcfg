# home-manager as a NixOS module. User factories import the portable baseline
# and optional home/<user>/<host>.nix entrypoint.
{ flake, ... }:
{
  imports = [
    flake.inputs.home-manager.nixosModules.home-manager
  ];

  home-manager = {
    useGlobalPkgs = true;
    useUserPackages = true;
    backupFileExtension = "hm-backup";
    extraSpecialArgs = { inherit flake; };

    # Custom option-only HM modules available to every user, plus opnix
    # (inert unless a user enables programs.onepassword-secrets).
    sharedModules = builtins.attrValues flake.outputs.homeManagerModules ++ [
      flake.inputs.opnix.homeManagerModules.default
    ];
  };
}

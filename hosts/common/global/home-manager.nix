# home-manager as a NixOS module, shared by every host. Per-user wiring
# (including which home/<user>/<host>.nix entrypoint is used) lives in
# hosts/common/users/.
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

    # Custom option-only HM modules available to every user.
    sharedModules = builtins.attrValues flake.outputs.homeManagerModules;
  };
}

{ flake, ... }:
{
  imports = [
    ./homebrew.nix
    flake.inputs.home-manager.darwinModules.home-manager
  ];

  nix = {
    enable = true;
    settings = {
      experimental-features = [
        "nix-command"
        "flakes"
      ];
      trusted-users = [ "@admin" ];
    };
  };

  nixpkgs.config.allowUnfree = true;

  home-manager = {
    useGlobalPkgs = true;
    useUserPackages = true;
    backupFileExtension = "hm-backup";
    extraSpecialArgs = { inherit flake; };
    sharedModules = builtins.attrValues flake.outputs.homeManagerModules ++ [
      flake.inputs.opnix.homeManagerModules.default
    ];
  };
}

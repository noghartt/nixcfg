{
  self,
  lib,
}:
{
  # Map a function over every directory inside `dir`, keyed by directory
  # name. Lets flake.nix discover hosts and users without being edited.
  mapDir =
    f: dir:
    lib.pipe (builtins.readDir dir) [
      (lib.filterAttrs (_: type: type == "directory"))
      (builtins.mapAttrs (name: _: f name))
    ];

  mkNixOSConfig =
    { hostName, hostFile }:
    let
      # Host files are host SPECS, not plain NixOS modules: functions of
      # { users, lib, ... } returning fields that get mapped into a module.
      spec = import hostFile {
        inherit lib;
        inherit (self.outputs) users;
      };

      # A spec `users` entry is either already a module (a factory that was
      # called or overrideAttrs'd) or a user factory (bare functor attrset),
      # called here with { } for the default configuration.
      asModule =
        u:
        if builtins.isAttrs u then
          if u ? __functor then u { } else u
        else if !(builtins.isFunction u) then
          u
        else if (builtins.functionArgs u) ? config then
          u
        else
          u { };

      hostModule = (builtins.removeAttrs spec [ "users" ]) // {
        imports = (spec.imports or [ ]) ++ map asModule (spec.users or [ ]);
      };
    in
    lib.nixosSystem {
      system = "x86_64-linux";
      specialArgs = {
        flake = self;
      };
      modules = [
        { networking.hostName = lib.mkDefault hostName; }
        hostModule
      ]
      # Option-only custom modules available to every host.
      ++ builtins.attrValues self.outputs.nixosModules;
    };
}

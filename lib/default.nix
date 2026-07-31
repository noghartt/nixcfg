{
  self,
  lib,
}:
let
  importSpec =
    hostFile:
    import hostFile {
      inherit lib;
      inherit (self.outputs) users;
    };

  # Host files are specs rather than plain modules. Resolve their selected user
  # factories identically for NixOS and Darwin.
  resolveHostModule =
    hostFile:
    let
      spec = importSpec hostFile;

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
    in
    (builtins.removeAttrs spec [ "users" ])
    // {
      imports = (spec.imports or [ ]) ++ map asModule (spec.users or [ ]);
    };
in
{
  # Map a function over every directory inside `dir`, keyed by directory
  # name. Lets flake.nix discover hosts and users without being edited.
  mapDir =
    f: dir:
    lib.pipe (builtins.readDir dir) [
      (lib.filterAttrs (_: type: type == "directory"))
      (builtins.mapAttrs (name: _: f name))
    ];

  # Darwin hosts have no hardware-configuration.nix, so their spec must carry
  # nixpkgs.hostPlatform inline — which doubles as the discovery signal that
  # routes a hosts/ directory to mkDarwinConfig instead of mkNixOSConfig.
  isDarwinHost =
    hostFile:
    let
      platform = lib.attrByPath [ "nixpkgs" "hostPlatform" ] "" (importSpec hostFile);
    in
    lib.hasSuffix "-darwin" (if lib.isString platform then platform else platform.system or "");

  mkNixOSConfig =
    { hostName, hostFile }:
    # No `system` here: each host declares its own platform via
    # `nixpkgs.hostPlatform` (hardware-configuration.nix already does).
    lib.nixosSystem {
      specialArgs = {
        flake = self;
      };
      modules = [
        { networking.hostName = lib.mkDefault hostName; }
        (resolveHostModule hostFile)
      ]
      # Option-only custom modules available to every host.
      ++ builtins.attrValues self.outputs.nixosModules;
    };

  # Darwin uses the same host-spec and user-factory contract as NixOS.
  mkDarwinConfig =
    { hostName, hostFile }:
    self.inputs.nix-darwin.lib.darwinSystem {
      specialArgs = {
        flake = self;
      };

      modules = [
        {
          # macOS keeps three names; default them all to the host's directory
          # name so the user-facing ComputerName and Bonjour name follow suit.
          networking = {
            hostName = lib.mkDefault hostName;
            computerName = lib.mkDefault hostName;
            localHostName = lib.mkDefault hostName;
          };
          system.configurationRevision = self.rev or (self.dirtyRev or "dirty");
        }
        (resolveHostModule hostFile)
      ]
      # The system-side device option is platform-neutral despite the standard
      # flake output name, and is mirrored into Home Manager by user factories.
      ++ builtins.attrValues self.outputs.nixosModules;
    };
}

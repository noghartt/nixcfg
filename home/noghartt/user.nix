# Overridable factory for this user's system-side definition (a NIXOS
# module — the rest of home/noghartt/ is HM config). Host specs use it as:
#   noghartt                                   defaults
#   noghartt { extraGroups = [ ... ]; }        replace fields wholesale
#   noghartt.overrideAttrs (old: { ... })      extend the defaults
let
  defaults = {
    extraGroups = [
      "wheel"
      "networkmanager"
    ];
  };

  mkModule =
    cfg:
    {
      config,
      lib,
      pkgs,
      ...
    }:
    let
      username = "noghartt";
      hostEntrypoint = ./. + "/${config.networking.hostName}.nix";
    in
    {
      users.users.${username} = {
        isNormalUser = true;
        inherit (cfg) extraGroups;
        shell = pkgs.zsh;
      };

      # Login shell needs the system-level module so it lands in /etc/shells.
      programs.zsh.enable = true;

      home-manager.users.${username} = {
        # Forward the system-level device namespace into HM.
        inherit (config) device;

        imports = [ ./home.nix ] ++ lib.optional (builtins.pathExists hostEntrypoint) hostEntrypoint;

        home.stateVersion = lib.mkDefault config.system.stateVersion;
      };
    };

  mkFactory = cfg: {
    __functor = _: overrides: mkModule (cfg // overrides);
    overrideAttrs = f: mkFactory (cfg // f cfg);
  };
in
mkFactory defaults

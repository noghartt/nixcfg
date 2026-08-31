# Overridable factory for this user's system-side definition. Host specs use it as:
#   noghartt                                   defaults
#   noghartt { extraGroups = [ ... ]; }        override defaults
#   noghartt.overrideAttrs (old: { ... })      extend the defaults
let
  defaults = {
    extraGroups = [
      "wheel"
      "networkmanager"
    ];
    homeStateVersion = "26.11";
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
      isDarwin = pkgs.stdenv.hostPlatform.isDarwin;
    in
    {
      users.users.${username} =
        if isDarwin then
          {
            # Setup Assistant owns the account; nix-darwin only needs its home.
            home = "/Users/${username}";
          }
        else
          {
            isNormalUser = true;
            inherit (cfg) extraGroups;
            shell = pkgs.zsh;
          };

      # Login shell needs the system-level module so it lands in /etc/shells.
      programs.zsh.enable = lib.mkIf (!isDarwin) true;

      home-manager.users.${username} = {
        # Forward the system-level device namespace into HM.
        inherit (config) device;

        imports = [ ./home.nix ] ++ lib.optional (builtins.pathExists hostEntrypoint) hostEntrypoint;

        home.stateVersion = lib.mkDefault cfg.homeStateVersion;
      };
    };

  mkFactory = cfg: {
    __functor = _: overrides: mkModule (cfg // overrides);
    overrideAttrs = f: mkFactory (cfg // f cfg);
  };
in
mkFactory defaults

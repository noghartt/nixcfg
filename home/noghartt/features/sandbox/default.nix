# sbx: sandboxes for agents and jobs behind a provider interface, exe.dev
# first (docs/sandbox.md). Nix owns the kinds; exe.dev owns all sandbox state.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  sbx = pkgs.callPackage ./package.nix { };
  # exeuntu already ships git, curl and build tools; this adds what agents reach for.
  tools = ''
    #!/bin/sh
    set -e
    sudo apt-get update -q
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q ripgrep fd-find jq
  '';
  settings = {
    defaultKind = "dev";
    providers.exe.type = "exe";
    kinds = {
      dev = {
        provider = "exe";
        egress = "all";
        cpu = 2;
        memory = 4;
        setup = tools;
      };
      # No public internet. The account's `llm` integration is attached to every VM
      # (auto:all) and `sbx github add` attaches repositories to tag:sbx, so neither
      # is listed here. A setup script would need the internet, so extra tooling for
      # this kind goes in a template (`sbx template build agent`), which is built
      # with egress and copied without it.
      agent = {
        provider = "exe";
        egress = "integrations";
        cpu = 2;
        memory = 4;
      };
      # The whole Personal pool, for one-off compute; `sbx run` removes it afterwards.
      job = {
        provider = "exe";
        egress = "all";
        cpu = 4;
        memory = 8;
        setup = tools;
      };
    };
    reap.days = 7;
  };
  reap = [
    (lib.getExe sbx)
    "reap"
    "--if-configured"
  ];
in
{
  home.packages = [ sbx ];

  xdg.configFile."sbx/config.json".text = builtins.toJSON settings;

  systemd.user = lib.mkIf pkgs.stdenv.hostPlatform.isLinux {
    services.sbx-reap = {
      Unit.Description = "Remove idle sbx sandboxes";
      Service = {
        Type = "oneshot";
        ExecStart = lib.escapeShellArgs reap;
      };
    };
    timers.sbx-reap = {
      Unit.Description = "Hourly sbx reaper";
      Timer = {
        OnCalendar = "hourly";
        Persistent = true;
        RandomizedDelaySec = "5m";
      };
      Install.WantedBy = [ "timers.target" ];
    };
  };

  launchd.agents.sbx-reap = lib.mkIf pkgs.stdenv.hostPlatform.isDarwin {
    enable = true;
    config = {
      ProgramArguments = reap;
      StartInterval = 3600;
      ProcessType = "Background";
      StandardErrorPath = "${config.home.homeDirectory}/Library/Logs/sbx-reap.log";
    };
  };
}

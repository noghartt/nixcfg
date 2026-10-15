# exebox: agent sandboxes on exe.dev VMs with agentbox's command contract, so
# `omo --cloud exe --sandbox` works like `--cloud local --sandbox` on Mellon.
# Sandboxes come out of the exe.dev account's pool; only committed history
# crosses in either direction, as git bundles.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  # exe.dev's published host key (docs/faq/host-key, SHA256:JJOP/lwi...); the
  # lobby and the VM proxy present the same key.
  knownHosts = pkgs.writeText "exe-dev-known-hosts" ''
    exe.dev,vm.exe.xyz,*.exe.xyz ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQDEKtEcRW8OBtro5B/MG+EaisD+ZVwwHFa5m7M8wFwBlMmPJJssY+1aGBRW3b9InAeCnTU2Kt7gazqbg/9od1KnK6x5piQNVQZ4C/lrjsC2ScBrOydnw9ry9G2+voFCAk+dQGabIrIT6gqqDJNOqxgFiG/lA3Xx6KwpfwI2BH5f3ab2fHCR2BGAC5jlB2RJXPgly80hMxYEHqexhJxYRwC+deeLrQSG795we9rSzPmdz58t9+9jLTKkyyqWKe/hmBvty1AYrEmRsefu6/TUrIGi/UWJfa+RBIQtFgWqN6xT1F6rRwELeVOfwwr5tZbsmgWY5frZU3EOtVWcF7Ve3gfL
  '';

  # ssh stays the one on PATH, so ~/.ssh/config (the 1Password agent) applies
  # exactly as it does for cloud-mode's own connections.
  script = pkgs.writeShellApplication {
    name = "exebox";
    runtimeInputs = [
      pkgs.coreutils
      pkgs.findutils
      pkgs.git
      pkgs.jq
      pkgs.ps
    ];
    text = ''
      KNOWN_HOSTS=${knownHosts}
      EXPIRE_DAYS=7
      ARCHIVE_DAYS=30
    ''
    + builtins.readFile ./exebox.sh;
  };

  # The contract tests run against a fake ssh at build time, so a broken
  # seed, collect or reap fails the build rather than a session.
  exebox =
    pkgs.runCommand "exebox"
      {
        nativeBuildInputs = [
          pkgs.git
          pkgs.ripgrep
        ];
        meta.mainProgram = "exebox";
      }
      ''
        HOME=$TMPDIR bash ${./test.sh} ${lib.getExe script}
        mkdir -p $out/bin
        ln -s ${lib.getExe script} $out/bin/exebox
      '';
in
{
  home.packages = [ exebox ];

  # exe.dev has no idle reaper of its own, and every VM holds a share of the
  # pool and one of the plan's VM slots.
  launchd.agents.exebox-reap = lib.mkIf pkgs.stdenv.hostPlatform.isDarwin {
    enable = true;
    config = {
      ProgramArguments = [
        (lib.getExe exebox)
        "reap"
      ];
      StartInterval = 3600;
      ProcessType = "Background";
      StandardErrorPath = "${config.home.homeDirectory}/Library/Logs/exebox-reap.log";
    };
  };
}

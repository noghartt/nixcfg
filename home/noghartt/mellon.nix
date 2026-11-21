# Mellon's portable desktop plus Linux/Wayland integrations; Ghostty launches Herdr directly.
{
  config,
  lib,
  osConfig,
  pkgs,
  ...
}:
{
  imports = [
    ./features/cli/ssh-server.nix
    ./features/desktop
    ./features/desktop/niri.nix
    ./features/desktop/noctalia.nix
    ./features/desktop/wlsunset.nix
    ./features/omo
  ];

  home.packages = with pkgs; [
    # Clipboard backend for Herdr's copy actions on Wayland.
    wl-clipboard
    # Per-app volume and device routing for the PipeWire stack.
    pavucontrol
    # Guitar amp/effects (JACK client on PipeWire; low latency in hosts/mellon/audio.nix),
    # and a patchbay to wire the interface's input through it to the outputs.
    # NixOS reaches PipeWire's libjack through the session's LD_LIBRARY_PATH, which
    # a launcher holding a capability (Hyprland's CAP_SYS_NICE did) makes glibc drop;
    # Guitarix then fell back to JACK2's libjack with no server. Pin PipeWire's directly.
    (symlinkJoin {
      name = "guitarix-pipewire";
      paths = [ guitarix ];
      nativeBuildInputs = [ makeWrapper ];
      postBuild = ''
        rm $out/bin/guitarix
        makeWrapper ${guitarix}/bin/guitarix $out/bin/guitarix \
          --prefix LD_LIBRARY_PATH : ${osConfig.services.pipewire.package.jack}/lib
      '';
    })
    qpwgraph
    calibre
    todoist-electron
    prismlauncher
  ];

  programs.ghostty = {
    package = pkgs.ghostty;
    settings.command = lib.getExe config.programs.herdr.package;
  };

  # Mellon's own GitHub key for unattended pushes (hosts/mellon/github-ssh.nix):
  # an SSH Key item in the Nix vault, in the OpenSSH format the ssh client reads.
  # The item must exist before activation; a missing one fails every opnix secret.
  programs.onepassword-secrets.secrets.githubSshKey = {
    reference = "op://Nix/mellon-github/private key?ssh-format=openssh";
    path = ".ssh/github_mellon";
  };

  services.flameshot.settings.General.disabledTrayIcon = true;

  xdg.mimeApps = {
    enable = true;
    defaultApplications = {
      "application/xhtml+xml" = [ "firefox.desktop" ];
      "text/html" = [ "firefox.desktop" ];
      "x-scheme-handler/http" = [ "firefox.desktop" ];
      "x-scheme-handler/https" = [ "firefox.desktop" ];
      "x-scheme-handler/slack" = [ "slack.desktop" ];
      "x-scheme-handler/todoist" = [ "todoist.desktop" ];
    };
  };
}

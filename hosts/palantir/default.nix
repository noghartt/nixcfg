{ users, ... }:
{
  imports = [
    ../common/darwin
  ];

  users = [
    users.noghartt
  ];

  nixpkgs.hostPlatform = "aarch64-darwin";
  device.type = "laptop";

  # Apps unavailable or unsuitable through nixpkgs on Darwin.
  homebrew.casks = [
    "1password"
    "granola"
    # Docker engine + CLI + compose; Apple's native `container` 1.0 still has
    # no Docker API or compose support, so OrbStack stays (revisit later).
    "orbstack"
    "raycast"
    "slack"
    "tailscale-app"
  ];

  system = {
    primaryUser = "noghartt";
    stateVersion = 7;

    # English UI with pt-BR as fallback; not typed nix-darwin options, so they
    # go through the freeform defaults writer.
    defaults.CustomUserPreferences.NSGlobalDomain = {
      AppleLanguages = [
        "en-US"
        "pt-BR"
      ];
      AppleLocale = "en_US";
    };
  };
}

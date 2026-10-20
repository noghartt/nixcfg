# System side shared by the MacBooks (palantir, mithril), so both Macs keep
# the same apps and preferences; host specs add only what differs.
{
  device.type = "laptop";

  # Apps unavailable or unsuitable through nixpkgs on Darwin.
  homebrew.casks = [
    "1password"
    "claude"
    "cloudflare-warp"
    "discord"
    "granola"
    # Docker engine + CLI + compose; Apple's native `container` 1.0 still has
    # no Docker API or compose support, so OrbStack stays (revisit later).
    "orbstack"
    "raycast"
    "slack"
    # Unfree, so never binary-cached: the nixpkgs package re-downloads ~300MB
    # on every bump and blocks self-updates; the cask lets it update itself.
    "spotify"
    "tailscale-app"
    "todoist-app"
    "zotero"
    "openlogi"
    # Docker Sandboxes CLI: microVM sandboxes for swarm members (SWARM.md).
    # Docker ships it as a cask, not a formula; brew refuses untrusted taps.
    {
      name = "docker/tap/sbx";
      trusted = true;
    }
  ];

  # Declared so `zap` cleanup keeps the tap.
  homebrew.taps = [ "docker/tap" ];

  system = {
    primaryUser = "noghartt";

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

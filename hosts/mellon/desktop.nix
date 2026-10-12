# Wayland desktop stack: Hyprland + greetd + keyring + pipewire + bluetooth.
{ pkgs, ... }:
{
  programs.hyprland = {
    enable = true;
    xwayland.enable = true;
  };

  security = {
    polkit.enable = true;
    rtkit.enable = true;
  };

  # Secret Service provider: without one, 1Password and other libsecret apps
  # cannot persist secrets (1Password drops its 2FA token at every lock).
  programs.seahorse.enable = true;

  services = {
    # Minimal greeter straight into the Hyprland session.
    greetd = {
      enable = true;
      settings.default_session = {
        command = "${pkgs.tuigreet}/bin/tuigreet --time --remember --cmd start-hyprland";
        user = "greeter";
      };
    };

    pipewire = {
      enable = true;
      alsa.enable = true;
      alsa.support32Bit = true;
      pulse.enable = true;
      jack.enable = true;
    };

    blueman.enable = true;
    upower.enable = true;
    systemd-lock-handler.enable = true;

    # Also adds pam_gnome_keyring to the login stack, which greetd includes,
    # so the greetd password unlocks the login keyring.
    gnome.gnome-keyring.enable = true;
    # 1Password is the SSH agent; keep gcr's agent out of SSH_AUTH_SOCK.
    gnome.gcr-ssh-agent.enable = false;

    # Give the user session time to acknowledge its lock before sleep.
    logind.settings.Login.InhibitDelayMaxSec = "30s";

    xserver.xkb = {
      layout = "us";
      variant = "intl";
    };
  };

  # RTL8922AE has rough BT/WiFi coexistence (noted on fersilva16's identical
  # NIC): if WiFi drops, test with bluetooth off before blaming the driver.
  hardware.bluetooth = {
    enable = true;
    powerOnBoot = true;
  };

  # Chromium/Electron apps go Wayland-native.
  environment.sessionVariables = {
    NIXOS_OZONE_WL = "1";
    # GTK4 (Ghostty) otherwise routes keys through Hyprland's text-input-v3,
    # which with no input method running swallows us-intl dead keys entirely.
    GTK_IM_MODULE = "simple";
  };

  fonts.packages = with pkgs; [
    dejavu_fonts
    noto-fonts
    noto-fonts-color-emoji
  ];
}

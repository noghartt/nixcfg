# Wayland desktop stack: Hyprland + greetd + pipewire + bluetooth.
{ pkgs, ... }:
{
  programs.hyprland = {
    enable = true;
    xwayland.enable = true;
  };

  security.rtkit.enable = true;

  services = {
    # Minimal greeter straight into the Hyprland session.
    greetd = {
      enable = true;
      settings.default_session = {
        command = "${pkgs.tuigreet}/bin/tuigreet --time --remember --cmd Hyprland";
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
  };

  # RTL8922AE has rough BT/WiFi coexistence (noted on fersilva16's identical
  # NIC): if WiFi drops, test with bluetooth off before blaming the driver.
  hardware.bluetooth = {
    enable = true;
    powerOnBoot = true;
  };

  # Chromium/Electron apps go Wayland-native.
  environment.sessionVariables.NIXOS_OZONE_WL = "1";

  fonts.packages = with pkgs; [
    dejavu_fonts
    noto-fonts
    noto-fonts-color-emoji
  ];
}

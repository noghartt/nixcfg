# Minimal Hyprland session; rice from here. No legacy NVIDIA env hacks:
# with the open kernel module (see hosts/mellon/nvidia.nix) the old
# GBM/WLR workarounds are obsolete.
{
  wayland.windowManager.hyprland = {
    enable = true;
    settings = {
      monitor = [ ",preferred,auto,1" ];

      "$mod" = "SUPER";
      bind = [
        "$mod, Return, exec, ghostty"
        "$mod, Q, killactive"
        "$mod SHIFT, E, exit"
      ];
    };
  };
}

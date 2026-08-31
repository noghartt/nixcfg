{ lib, ... }:
# Same option namespace as modules/nixos/device.nix, on the HM side. User
# factories forward the system-level value.
{
  options.device.type = lib.mkOption {
    type = lib.types.enum [
      "desktop"
      "laptop"
      "server"
    ];
    default = "desktop";
    description = "Kind of machine, mirrored from the system configuration.";
  };
}

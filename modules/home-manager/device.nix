{ lib, ... }:
# Same option namespace as modules/nixos/device.nix, on the HM side. The
# system-level value is forwarded by hosts/common/users/<user>.nix.
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

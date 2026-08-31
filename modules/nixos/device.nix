{ lib, ... }:
{
  options.device.type = lib.mkOption {
    type = lib.types.enum [
      "desktop"
      "laptop"
      "server"
    ];
    default = "desktop";
    description = "Kind of machine; lets modules and HM features key off what the host is.";
  };
}

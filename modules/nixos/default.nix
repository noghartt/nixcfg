# Custom NixOS modules. These only DECLARE options (never config), so they
# are safe to auto-import into every host — mkNixOSConfig does exactly that.
{
  device = import ./device.nix;
}

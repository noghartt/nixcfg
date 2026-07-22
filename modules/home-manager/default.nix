# Custom home-manager modules. Option-only; auto-imported into every user
# via home-manager.sharedModules (see hosts/common/global/home-manager.nix).
{
  device = import ./device.nix;
}

{ config }:

{
  imports = [
    ./programs
  ];

  home.file."hm-config" = {
    source = ".config/nixpkgs";
    target = config.lib.file.mkOutOfStoreSymlink "/dotfiles";
  };
}

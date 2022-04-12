{ inputs, config, pkgs, ... }:

{
  imports = [
    inputs.doom-emacs.hmModule

    ./programs/xmonad
    ./programs/git.nix
    ./programs/firefox.nix
    ./programs/emacs.nix
    ./programs/qutebrowser.nix

    ./terminal/alacritty.nix
    ./terminal/fish.nix

    ./services/redshift.nix
  ];

  home.packages = with pkgs;  [
    pavucontrol
    discord
    neofetch
    google-chrome
    # NOTE: We need to add `gh` as a "simple" package because it's broken.
    #       If we try to add as `program.gh` and do the auth flow, it will
    #       log a error saying that the `config.yml` file is a readonly file.
    #       There's a PR fixing it, see here: https://github.com/cli/cli/pull/5378
    #
    # TODO: Maybe we could write an overlay pointing the fix on this PR.
    gh
    nyxt
    steam
    xfce.thunar
  ];

  home.file."homecfg" = {
    target = ".config/nixpkgs";
    source = config.lib.file.mkOutOfStoreSymlink "/dotfiles";
  };
}

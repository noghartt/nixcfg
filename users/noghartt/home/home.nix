{ inputs, ... }:

{
  imports = [
    inputs.doom-emacs.hmModule

    ./programs/git.nix
    ./programs/firefox.nix
  ];
}

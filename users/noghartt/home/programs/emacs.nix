{ pkgs, username, ... }:

{
  programs.doom-emacs = {
    enable = true;
    doomPrivateDir = "/home/${username}/.config/doom";
    emacsPackage = pkgs.emacsUnstable;
  };

  services.emacs = { enable = true; };
}

{
  programs.gnupg.agent = {
    enable = true;
    pinentryFlavor = "emacs";
  };

  services.gnome.gnome-keyring.enable = true;
}

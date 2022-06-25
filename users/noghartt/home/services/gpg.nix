{ ... }:

{
  services.gnome-keyring.enable = true;

  services.gpg-agent = {
    enable = true;

    pinentryFlavor = "tty";

    extraConfig = ''
      allow-emacs-pinentry
      allow-loopback-pinentry
    '';
  };

  programs.gpg = {
    enable = true;
  };
}

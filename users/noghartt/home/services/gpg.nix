{ ... }:

{
  services.gnome-keyring.enable = true;

  services.gpg-agent = {
    enable = true;

    pinentryFlavor = "tty";

    defaultCacheTtl = 34560000;
    maxCacheTtl = 34560000;

    extraConfig = ''
      allow-emacs-pinentry
      allow-loopback-pinentry
    '';
  };

  programs.gpg = {
    enable = true;
  };
}

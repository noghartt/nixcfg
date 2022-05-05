{
  services.openssh.enable = true;

  services.gnome3.gnome-keyring.enable = true;
  security.pam.services.lightdm.enableGnomeKeyring = true;

  programs.ssh.startAgent = true;
}

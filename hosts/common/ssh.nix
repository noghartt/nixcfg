{
  services.openssh.enable = true;

  programs.ssh = {
    startAgent = true;

    extraConfig = ''
      AddKeysToAgent yes
    '';
  };

  services.gnome.gnome-keyring.enable = true;
  security.pam.services.lightdm.enableGnomeKeyring = true;

}

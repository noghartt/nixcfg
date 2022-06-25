{
  services.openssh.enable = true;

  programs.ssh = {
    startAgent = true;

    extraConfig = ''
      AddKeysToAgent yes
    '';
  };
}

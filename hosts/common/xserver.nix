{
  services.xserver = {
    enable = true;

    displayManager = {
      defaultSession = "xsession";

      session = [
        {
          name = "xsession";
          manage = "desktop";
          start = ''
            exec $HOME/.xsession
          '';
        }
      ];
    };
  };
}

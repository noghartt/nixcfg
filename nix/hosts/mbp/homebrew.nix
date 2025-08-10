_:

{
  # nix-homebrew = {
  #   enable = true;
  #
  #   enableRosetta = true;
  #
  #   user = "noghartt";
  #
  #   autoMigrate = true;
  # };

  homebrew = {
    enable = true;

    brews = [
      # "ollama"
      "helm"
      "mit-scheme"
      "ffmpeg"
      "socat"
    ];

    casks = [
      "firefox"
      "1password-cli"
      "discord"
      "alacritty"
      "spotify"
      "rescuetime"
      "anki"
      "container"
    ];
  };
}

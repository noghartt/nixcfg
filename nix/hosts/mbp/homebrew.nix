_:

{
  nix-homebrew = {
    enable = true;

    enableRosetta = true;

    user = "noghartt";

    autoMigrate = true;
  };

  homebrew = {
    enable = true;

    brews = [
      "ollama"
      "helm"
    ];

    casks = [
      "firefox"
      "1password-cli"
      "discord"
      "alacritty"
      "spotify"
      "rescuetime"
    ];
  };
}

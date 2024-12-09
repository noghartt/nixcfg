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
      "beancount"
      "fava"
      "gh"
    ];

    casks = [
      "firefox"
      "1password-cli"
      "discord"
      "visual-studio-code"
      "alacritty"
    ];
  };
}
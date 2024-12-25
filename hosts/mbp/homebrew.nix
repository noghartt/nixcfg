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
      # TODO: See how to approach `programs.neovim` on Nix.
      "neovim"
    ];

    casks = [
      "firefox"
      "1password-cli"
      "discord"
      "alacritty"
      "spotify"
    ];
  };
}
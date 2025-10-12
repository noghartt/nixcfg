_:

{
  programs.ghostty = {
    enable = true;

    # enableFishIntegration = true;
    enableZshIntegration = true;

    settings = {
      theme = "Gruvbox Light";
      font-family = "Iosevka";
      font-feature = "-calt, -liga, -dlig";
    };
  };
}

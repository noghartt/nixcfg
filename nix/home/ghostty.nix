_:

{
  programs.ghostty = {
    enable = true;

    # enableFishIntegration = true;
    enableZshIntegration = true;

    settings = {
      theme = "GruvboxLight";
      font-family = "Iosevka";
      font-feature = "-calt, -liga, -dlig";
    };
  };
}

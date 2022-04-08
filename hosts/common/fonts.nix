{ pkgs }:

{
  fonts = {
    enableDefaultFonts = true;

    fonts = with pkgs; [
      noto-fonts
      noto-fonts-cjk
      noto-fonts-extra
      twitter-color-emoji
      (nerdfonts.override { fonts = [ "Hack" "FiraMono" "Monoid" "Meslo" "LiberationMono" ]; })
    ];
  };
}

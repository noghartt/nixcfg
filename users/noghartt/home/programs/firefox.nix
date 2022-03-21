{ pkgs }:

{
  programs.firefox = {
    enable = true;

    extensions = with pkgs.nur.repos.rycee.firefox-addons; [
      bitwarden
      ublock-origin
    ];

    profiles =
      let
        settings = {
          "browser.safebrowsing.malware.enabled" = false;
          "browser.helperApps.deleteTempFileOnExit" = false;

          "privacy.userContext.enabled" = true;
          "privacy.userContext.ui.enabled" = true;

          "dom.disable_open_during_load" = true;

          "extensions.pocket.enabled" = false;
          "extensions.screenshot.enabled" = false;

          "acessibility.force_disabled" = 1;

          "beacon.enabled" = false;

          "network.cookie.lifetimePolicy" = 2;
          "network.cookie.thirdparty.sessionOnly" = true;
          "network.cookie.thirdparty.nonsecureSessionOnly" = true;
        };
      in {

      };
  };
}

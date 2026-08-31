# Firefox with the extension set replicated from the pre-NixOS profile.
# Most come pinned from rycee's firefox-addons (flake input); the rest go
# through browser policies (see below for why).
{ pkgs, flake, ... }:
{
  programs.firefox = {
    enable = true;

    profiles.default = {
      isDefault = true;

      # Keep the profile declarative: drop anything not in these lists.
      extensions.force = true;
      extensions.packages =
        with flake.inputs.firefox-addons.packages.${pkgs.stdenv.hostPlatform.system}; [
          ublock-origin
          sponsorblock
          dearrow
          vimium
          privacy-badger
          refined-github
          stylus
          wayback-machine
          archivebox-exporter
        ];
    };

    # These three are unfree-licensed; the addons flake evaluates with
    # allowUnfree = false, so they go through policies (AMO auto-update).
    policies.ExtensionSettings = {
      "zotero@chnm.gmu.edu" = {
        install_url = "https://addons.mozilla.org/firefox/downloads/latest/zotero-connector/latest.xpi";
        installation_mode = "force_installed";
      };
      "{d634138d-c276-4fc8-924b-40a0ea21d284}" = {
        install_url = "https://addons.mozilla.org/firefox/downloads/latest/1password-x-password-manager/latest.xpi";
        installation_mode = "force_installed";
      };
      "team@readwise.io" = {
        install_url = "https://addons.mozilla.org/firefox/downloads/latest/readwise-highlighter/latest.xpi";
        installation_mode = "force_installed";
      };
    };
  };
}

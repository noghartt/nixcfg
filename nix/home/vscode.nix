args @ { pkgs, ... }:

{
  programs.vscode = {
    enable = true;

    extensions = with pkgs.vscode-extensions; [
      editorconfig.editorconfig
      usernamehw.errorlens
      bbenoist.nix
      pkief.material-icon-theme
      astro-build.astro-vscode
      eamodio.gitlens
    ];

    userSettings = {
      "workbench.iconTheme" = "material-icon-theme";
      "workbench.startupEditor" = "none";

      "editor.tabSize" = 2;
    };
  };
}

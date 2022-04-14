{ pkgs, ... }:

{
  programs.vscode = {
    enable = true;

    extensions = with pkgs.vscode-extensions; [
      dbaeumer.vscode-eslint
      zhuangtongfa.material-theme
      esbenp.prettier-vscode
      pkief.material-icon-theme
    ];
  };
}

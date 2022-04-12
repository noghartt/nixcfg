{ pkgs, ... }:

{
  programs.git = {
    enable = true;
    package = pkgs.gitAndTools.gitFull;

    userName = "Guilherme Ananias";
    userEmail = "hi@noghartt.dev";

    extraConfig = {
      user = {
        signingkey = "D30A921C9BE397B8";
      };

      commit = {
        gpgsign = true;
      };

      core = {
        editor = "vim";
      };

      pull.rebase = false;
    };
  };
}

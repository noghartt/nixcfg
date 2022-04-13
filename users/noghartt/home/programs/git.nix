{ pkgs, ... }:

{
  programs.git = {
    enable = true;
    package = pkgs.gitAndTools.gitFull;

    userName = "Guilherme Ananias";
    userEmail = "hi@noghartt.dev";

    extraConfig = {
      user = {
        signingkey = "F7E2E3DBF4190AB7";
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

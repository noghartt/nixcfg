{ pkgs, ... }:

{
  programs.git = {
    enable = true;
    package = pkgs.gitAndTools.gitFull;

    userName = "Guilherme Ananias";
    userEmail = "hi@noghartt.dev";

    extraConfig = {
      core = {
        editor = "vim";
      };
      pull.rebase = false;
    };
  };

  programs.gh = {
    enable = true;
    settings.git_protocol = "ssh";
  };
}

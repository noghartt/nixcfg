{ pkgs, ... }:

{
  programs.git = {
    enable = true;
    package = pkgs.gitAndTools.gitFull;

    userName = "Guilherme Ananias";
    userEmail = "hi@noghartt.dev";
    core = {
      editor = "vim";
    };
    pull.rebase = false;
  };

  program.gh = {
    enable = true;
    settings.git_protocol = "ssh";
  };
}

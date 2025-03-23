{ pkgs, ... }:

{
  home.packages = with pkgs; [
    gh
  ];

  programs.git = {
    enable = true;
    lfs.enable = true;

    userName = builtins.getEnv "USER_NAME";
    userEmail = builtins.getEnv "USER_EMAIL";

    extraConfig = {
      gpg.format = "ssh";
      "gpg \"ssh\"".program = "/Applications/1Password.app/Contents/MacOS/op-ssh-sign";

      user.signingkey = builtins.getEnv "SSH_PUB_KEY";

      commit.gpgsign = true;

      init.defaultBranch = "main";

      pull.rebase = true;

      push.autoSetupRemote = true;

      column.ui = "auto";

      branch.sort = "-committerdate";

      tag.sort = "version:refname";

      diff = {
        algorithm = "histogram";
        colorMoved = "plain";
        mnemonicPrefix = true;
        renames = true;
      };

      fetch = {
        prune = true;
        pruneTags = true;
        all = true;
      };

      help.autocorrect = "prompt";

      commit.verbose = true;

      rerere = {
        enabled = true;
        autoupdate = true;
      };

      core = {
        excludesfile = "~/.gitconfig";
        editor = "nvim";
        fscache = "falseb";
      };

      rebase = {
        autoSquash = true;
        autoStash = true;
        updateRefs = true;
      };
    };
  };
}

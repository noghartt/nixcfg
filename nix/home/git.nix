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

      core.editor = "nvim";

      commit.gpgsign = true;

      init.defaultBranch = "main";

      pull.rebase = false;

      push.autoSetupRemote = true;
    };
  };
}

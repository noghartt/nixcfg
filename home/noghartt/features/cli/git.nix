# Git identity deliberately NOT set here — keep personal details out of
# the repo (see AGENTS.md). Set it via an untracked ~/.gitconfig include
# or a local override if wanted.
{
  programs.git = {
    enable = true;

    ignores = [ "**/.claude/settings.local.json" ];

    settings = {
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
        editor = "vim";
        fscache = false;
      };
      rebase = {
        autoSquash = true;
        autoStash = true;
        updateRefs = true;
      };
      alias.cann = "commit --amend --no-edit -n";
    };
  };

  # gh provides the git credential helper for github.com and gists.
  programs.gh = {
    enable = true;
    gitCredentialHelper.enable = true;
  };
}

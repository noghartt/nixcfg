# Git identity comes from 1Password via opnix, not from the repo (see
# AGENTS.md): create an item "git" in the Personal vault whose NOTES field
# holds exactly:
#   [user]
#   	name = <your name>
#   	email = <your email>
# opnix writes it to ~/.config/git/user at activation, and git includes it.
{ config, ... }:
{
  programs = {
    onepassword-secrets = {
      enable = true;
      tokenFile = "${config.home.homeDirectory}/.config/opnix/token";
      secrets.gitUser = {
        reference = "op://Personal/git/notes";
        path = ".config/git/user";
      };
    };

    git = {
      enable = true;

      # Path interpolation, the safe kind: the include points at the secret
      # file opnix writes, no value ever enters the store.
      includes = [ { path = config.programs.onepassword-secrets.secretPaths.gitUser; } ];

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
    gh = {
      enable = true;
      gitCredentialHelper.enable = true;
    };
  };
}

# Git identity comes from 1Password via opnix, not from the repo (see
# AGENTS.md): create an item "git" in the Nix vault with two text fields
# labeled `name` and `email`. opnix can only map one reference to one file,
# so the activation step below composes them into the ini include.
{ config, lib, ... }:
let
  gitIdentityFile = "${config.home.homeDirectory}/.config/git/user";
in
{
  # Runs after opnix has (re)written the field secrets; when retrieval was
  # skipped (no token yet) the parts are absent and the include stays as-is.
  home.activation.composeGitIdentity = lib.hm.dag.entryAfter [ "retrieveOpnixSecrets" ] ''
    namePath="${config.programs.onepassword-secrets.secretPaths.gitUserName}"
    emailPath="${config.programs.onepassword-secrets.secretPaths.gitUserEmail}"
    if [ -s "$namePath" ] && [ -s "$emailPath" ]; then
      printf '[user]\n\tname = %s\n\temail = %s\n' \
        "$(cat "$namePath")" "$(cat "$emailPath")" > "${gitIdentityFile}"
      chmod 600 "${gitIdentityFile}"
    fi
  '';

  programs = {
    onepassword-secrets = {
      enable = true;
      tokenFile = "${config.home.homeDirectory}/.config/opnix/token";
      secrets = {
        gitUserName = {
          reference = "op://Nix/git/name";
          path = ".config/git/user-name";
        };
        gitUserEmail = {
          reference = "op://Nix/git/email";
          path = ".config/git/user-email";
        };
      };
    };

    git = {
      enable = true;

      # Path interpolation, the safe kind: the include points at the file the
      # activation step composes, no value ever enters the store.
      includes = [ { path = gitIdentityFile; } ];

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
      settings.git_protocol = "ssh";
    };
  };
}

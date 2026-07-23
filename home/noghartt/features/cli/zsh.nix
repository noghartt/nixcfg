{ pkgs, ... }:
{
  programs.zsh = {
    enable = true;
    autosuggestion.enable = true;
    syntaxHighlighting.enable = true;

    oh-my-zsh = {
      enable = true;
      theme = "robbyrussell";
      plugins = [ "git" ];
    };

    # Not bundled with oh-my-zsh, loaded as a custom plugin.
    plugins = [
      {
        name = "zsh-completions";
        src = pkgs.zsh-completions;
      }
    ];

    sessionVariables = {
      MANPAGER = "nvim +Man!";
      BUN_INSTALL = "$HOME/.bun";
      FLYCTL_INSTALL = "$HOME/.fly";
    };

    # bat detects non-tty output and degrades to plain cat, so the alias
    # is safe for pipelines.
    shellAliases = {
      cat = "bat --paging=never --style=plain";
      claude-mem = ''bun "$HOME/.claude/plugins/marketplaces/thedotmack/plugin/scripts/worker-service.cjs"'';
      zotero-cli = "bun run ~/www/zotero-api-cli/src/index.ts";
    };
  };

  home.sessionPath = [
    "$HOME/.local/bin"
    "$HOME/.npm/bin"
    "$HOME/.bun/bin"
    "$HOME/.cargo/bin"
    "$HOME/.fly/bin"
    "$HOME/.opencode/bin"
  ];
}

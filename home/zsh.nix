{ ... }: 

{
  programs.zsh = {
    enable = true;

    shellAliases = {
      ls = "ls --color";
    };

    initExtra = ''
      export NVM_DIR="$([ -z "''${XDG_CONFIG_HOME-}" ] && printf %s "''${HOME}/.nvm" || printf %s "''${XDG_CONFIG_HOME}/nvm")"
      [ -s "''$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

      export PATH="$HOME/.config/nix/result/sw/bin:$PATH"
      export PATH="/opt/homebrew/bin:$PATH"
      export PATH="$HOME/.local/bin:$PATH"
    '';
  };
}
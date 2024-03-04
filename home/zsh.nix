{ ... }: 

{
  programs.zsh = {
    enable = true;

    enableAutosuggestions = true;
    syntaxHighlighting.enable = true;
    enableCompletion = true;
 
    shellAliases = {
      ls = "ls --color";
    };

    oh-my-zsh = {
      enable = true;
      theme = "robbyrussell";
      plugins = [
        "git"
        "sudo"
        "kubectl"
        "helm"
        "docker"
      ];
    };
  
    initExtra = ''
      ssh-add --apple-load-keychain 2> /dev/null

      export NVM_DIR="$([ -z "''${XDG_CONFIG_HOME-}" ] && printf %s "''${HOME}/.nvm" || printf %s "''${XDG_CONFIG_HOME}/nvm")"
      [ -s "''$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"

      export PATH="/usr/bin:$PATH"
      export PATH="/opt/homebrew/bin:$PATH"
      export PATH="$HOME/.local/bin:$PATH"
      export PATH="$HOME/.nix-profile/bin:$PATH"
      export PATH="/run/current-system/sw/bin:$PATH"
    '';
  };
}
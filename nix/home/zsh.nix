{ lib, ... }:

{
  programs.zsh = {
    enable = true;

    initContent =
      let
        zshConfigEarlyInit = lib.mkOrder 1000 ''
          if [ -e "$HOME/.env" ]; then
            source "$HOME/.env"
          fi

          ssh-add --apple-load-keychain 2>/dev/null || true
        '';

        zshConfigGeneral = lib.mkOrder 1500 ''
          export PATH="$HOME/.nix-profile/bin:$PATH"
          export PATH="$HOME/.cargo/bin:$PATH"
          export PATH="/run/current-system/sw/bin:$PATH"
          export PATH="/opt/homebrew/bin:$PATH"
          export PATH="/opt/local/bin:$PATH"
          export PATH="/usr/bin:$PATH"

          if [ -z "$TMUX" ] && [ -t 1 ]; then
            exec tmux
          fi

          export MANPAGER="nvim +Man!"
        '';
      in
      lib.mkMerge [
        zshConfigEarlyInit
        zshConfigGeneral
      ];

    syntaxHighlighting.enable = true;
    autosuggestion.enable = true;

    shellAliases = {
      gds = "git diff --staged";
      gd = "git diff";
      gs = "git status";
    };

    oh-my-zsh = {
      enable = true;

      theme = "robbyrussell";
      plugins = [
        "git"
        "sudo"
        "docker"
        "kubectl"
        "tmux"
      ];
    };
  };
}

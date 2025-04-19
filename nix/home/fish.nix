_:

{
  programs.fish = {
    enable = true;

    interactiveShellInit = ''
      if test -f $HOME/.env
        source $HOME/.env
      end

      ssh-add --apple-load-keychain 2> /dev/null

      fish_add_path -amP /usr/bin
      fish_add_path -amP /opt/homebrew/bin
      fish_add_path -amP /opt/local/bin
      fish_add_path -m /run/current-system/sw/bin
      fish_add_path -m $HOME/.nix-profile/bin

      if status is-interactive
      and not set -q TMUX
        exec tmux
      end
    '';

    shellAliases = {
      gds = "git diff --staged";
      gd = "git diff";
      gs = "git status";
    };
  };
}

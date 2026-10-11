# The login side of SSH for a host that runs sshd (mellon): which agent
# long-lived shells use. The daemon itself is host config. ~/.ssh/authorized_keys
# is deliberately unmanaged: opnix fails all of activation on one missing
# reference, and logins are opt-in by hand.
{ pkgs, ... }:
{
  # tmux and Herdr shells outlive the connection that started them, so the
  # per-connection agent socket they inherited goes stale. sshd runs ~/.ssh/rc
  # on each login: interactive ones repoint a fixed symlink at the live
  # forwarded agent, which the host's ssh_config prefers while it answers.
  # SSH_TTY keeps one-shot `ssh mellon cmd` and scp logins from repointing it
  # at a socket that disappears seconds later.
  # Adapted from github:fersilva16/nix-config (modules/cli/ssh.nix).
  home.file.".ssh/rc".text = ''
    if [ -n "$SSH_TTY" ] && [ -S "$SSH_AUTH_SOCK" ]; then
      ${pkgs.coreutils}/bin/ln -sfn "$SSH_AUTH_SOCK" "$HOME/.ssh/agent.sock"
    fi
  '';
}

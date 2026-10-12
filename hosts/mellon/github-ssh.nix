# Unattended git over SSH to GitHub. The desktop 1Password agent asks on screen
# before each new client signs and locks after an idle hour, so agent runs
# left overnight could never push. A dedicated GitHub key (an SSH Key item in
# the Nix vault, written to ~/.ssh/github_mellon by opnix in
# home/noghartt/mellon.nix) serves github.com only; every other host still
# signs through 1Password.
{
  programs.ssh = {
    # Pinned from GitHub's API (`gh api meta`), so a first unattended connection
    # never stops at host key verification.
    knownHosts.github = {
      hostNames = [ "github.com" ];
      publicKey = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl";
    };
    # ~/.ssh/config is read first and points IdentityAgent at 1Password for
    # every host, so the agent cannot be switched off here. IdentitiesOnly
    # limits ssh to this key, which the agent does not hold, so it signs from
    # the file and the agent is never asked to.
    extraConfig = ''
      Host github.com
        IdentityFile ~/.ssh/github_mellon
        IdentitiesOnly yes
    '';
  };
}

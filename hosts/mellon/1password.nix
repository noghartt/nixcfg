# 1Password on mellon: desktop app + CLI, SSH agent from the vault, and
# the opnix CLI for provisioning the secrets token (see TASK.md).
{ flake, pkgs, ... }:
{
  programs = {
    _1password.enable = true;
    _1password-gui = {
      enable = true;
      polkitPolicyOwners = [ "noghartt" ];
    };

    # Use 1Password as the SSH agent; keys never touch disk, except the GitHub
    # key unattended runs push with (github-ssh.nix). While someone is
    # logged in over SSH with a forwarded agent, ~/.ssh/rc points agent.sock at
    # it and it wins: nobody is at mellon's screen to answer the local app's
    # prompt. Once that connection ends the socket dies and 1Password is back.
    ssh.extraConfig = ''
      Match exec "test -S %d/.ssh/agent.sock"
        IdentityAgent %d/.ssh/agent.sock
      Host *
        IdentityAgent ~/.1password/agent.sock
    '';
  };

  environment.systemPackages = [
    flake.inputs.opnix.packages.${pkgs.stdenv.hostPlatform.system}.default
  ];
}

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

    # Use 1Password as the SSH agent; keys never touch disk.
    ssh.extraConfig = ''
      IdentityAgent ~/.1password/agent.sock
    '';
  };

  environment.systemPackages = [
    flake.inputs.opnix.packages.${pkgs.stdenv.hostPlatform.system}.default
  ];
}

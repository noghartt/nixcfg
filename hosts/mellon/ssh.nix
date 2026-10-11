# Remote access for mellon as an always-on agent host. sshd answers only on
# the tailnet: the firewall opens port 22 on tailscale0 alone, so the LAN and
# any port forward never see it. Key-only logins; authorized keys come from
# 1Password through opnix (home/noghartt/features/cli/ssh-server.nix).
# Hardening adapted from github:fersilva16/nix-config (modules/system/sshd.nix).
{
  services.openssh = {
    enable = true;
    openFirewall = false;
    settings = {
      PasswordAuthentication = false;
      KbdInteractiveAuthentication = false;
      PermitEmptyPasswords = false;
      PermitRootLogin = "no";
      HostbasedAuthentication = false;
      # Agent sandboxes get their own users; none of them may log in.
      AllowUsers = [ "noghartt" ];
      # The 1Password agent offers every stored key in turn, so a vault with
      # more keys than this needs IdentitiesOnly on the client (INSTALL.md).
      MaxAuthTries = 3;
      LoginGraceTime = 30;
    };
  };

  networking.firewall.interfaces.tailscale0.allowedTCPPorts = [ 22 ];
}

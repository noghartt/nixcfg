{ config, modulesPath, pkgs, lib, ... }:

{
  imports = [ (modulesPath + "/virtualisation/proxmox-lxc.nix") ];

  system.stateVersion = "24.11";

  systemd.mounts = [
    { where = "/sys/kernel/debug"; enable = false; }
  ];

  nix.settings = {
    sandbox = false;

    experimental-features = [ "nix-command" "flakes" ];
  };

  environment.systemPackages = with pkgs; [
    htop
    vim
    git
  ];

  proxmoxLXC = {
    manageNetwork = false;
    privileged = true;
  };

  security.pam.services.sshd.allowNullPassword = true;

  services.openssh = {
    enable = true;
    openFirewall = true;
    settings = {
        PermitRootLogin = "yes";
        PasswordAuthentication = true;
        PermitEmptyPasswords = "yes";
    };
  };
}


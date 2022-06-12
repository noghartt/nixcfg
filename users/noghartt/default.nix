{ pkgs, config, ... }:

{
  users.users.noghartt = {
    isNormalUser = true;
    shell = pkgs.fish;
    extraGroups = [
      "wheel"
      "networkmanager"
      "video"
      "docker"
      "adbusers"
    ];
    # Change the password after the first boot
    initialPassword = "changeme";
  };

  security.sudo.extraRules = [
    {
      runAs = "root";
      users = [ "noghartt" ];
      commands = [
        {
          command = "${config.system.build.nixos-rebuild}/bin/nixos-rebuild switch";
          options = [ "NOPASSWD" ];
        }
      ];
    }
  ];

  home-manager.users.noghartt = import ./home/home.nix;
}

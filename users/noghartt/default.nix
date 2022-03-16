{ pkgs, ... }:

{
  users.users.noghartt = {
    isNormalUser = true;
    shell = pkgs.fish;
    extraGroups = [
      "wheel"
      "networkmanager"
      "video"
      "docker"
    ];
    # Change the password after the first boot
    initialPassword = "changeme";
  };
}

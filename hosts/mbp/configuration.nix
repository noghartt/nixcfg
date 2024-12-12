_:

{
  system.stateVersion = 5;

  imports = [
    ./homebrew.nix
    ./launchd.nix
  ];

  services.nix-daemon.enable = true;

  users.users.noghartt = {
    home = "/Users/noghartt";
  };
 
  nix.extraOptions = ''
    auto-optimise-store = true
    experimental-features = nix-command flakes
    extra-platforms = x86_64-darwin aarch64-darwin
  '';
}

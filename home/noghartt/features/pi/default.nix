{
  imports = [
    ./settings.nix
    ./extensions/claude-bridge.nix
  ];

  programs.pi-coding-agent.enable = true;
  home.sessionVariables.PI_OFFLINE = true;
}

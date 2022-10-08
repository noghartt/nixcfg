{
  programs.gh = {
    enable = true;

    settings = {
      git_protocol = "ssh";
      prompt = "enable";
      editor = "vim";

      aliases = {
        "co" = "pr checkout";
      };
    };
  };
}
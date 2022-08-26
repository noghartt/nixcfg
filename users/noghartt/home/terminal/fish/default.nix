{ pkgs, lib, ... }:

let
  inherit (pkgs) fetchFromGitHub;
in
{
  programs.fish = {
    enable = true;

    shellInit = ''
      set -gx GPG_TTY (tty)

      set PATH $HOME/.npm-global/bin $PATH
    '';

    functions = {
      fish_command_not_found = "__fish_default_command_not_found_handler $argv";
      # TODO: This function is broken some of my theme configurations, I need
      #       understand why. So, for a while, I'll deactivate it.
      # fish_prompt = builtins.readFile ./functions/fish_prompt.fish;
    };

    plugins = [
      {
        name = "z";
        src = fetchFromGitHub {
          owner = "jethrokuan";
          repo = "z";
          rev = "85f863f20f24faf675827fb00f3a4e15c7838d76";
          sha256 = "+FUBM7CodtZrYKqU542fQD+ZDGrd2438trKM0tIESs0=";
        };
      }
      {
        name = "theme-nai";
        src = fetchFromGitHub {
          owner = "oh-my-fish";
          repo = "theme-nai";
          rev = "6f4471e9f32b5d89017c83ac2748ae79e5f0c204";
          sha256 = "g7b9sIyBJQDv9wlGY8Ya2gPEa6PLxY4BPGlC+wDIt5E=";
        };
      }
    ];
  };
}

{ username, ... }: 

let
  vscodeConfigDir = "Library/Application Support/Code/User";
in
{
  homebrew.casks = [
    "visual-studio-code"
  ];

  home-manager.users.${username} = {
    home.file."${vscodeConfigDir}/settings.json" = {
      source = ./settings.json;
      force = true;
    };
  };
}

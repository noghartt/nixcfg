{ flake, ... }:
{
  programs.pi-coding-agent = {
    settings = {
      compaction = {
        enabled = true;
        keepRecentTokens = 20000;
        reserveTokens = 16384;
      };
      defaultProvider = "openai-codex";
      defaultModel = "gpt-5.6-sol";
      enabledModels = [
        "openai-codex/gpt-5.6-sol"
        "openai-codex/gpt-5.6-terra"
        "openai-codex/gpt-5.6-luna"
        "anthropic/claude-opus-5"
        "anthropic/claude-sonnet-5"
        "anthropic/claude-fable-5-1"
      ];
      skills = [ "${flake.inputs.herdr}/skills/herdr" ];
    };

    keybindings."app.editor.external" = [ "alt+e" ];
  };
}

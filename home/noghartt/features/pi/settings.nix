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
        "claude-bridge/claude-opus-4-8"
        "claude-bridge/claude-sonnet-4-6"
        "claude-bridge/claude-haiku-4-5"
        "claude-bridge/claude-opus-5"
        "claude-bridge/claude-sonnet-5"
        "claude-bridge/claude-fable-5"
      ];
      skills = [ "${flake.inputs.herdr}/skills/herdr" ];
    };

    keybindings."app.editor.external" = [ "alt+e" ];
  };
}

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
      # The statusline sidebar is a layout column, which only the alt-screen TUI has;
      # regular mode writes to scrollback and falls back to a full footer.
      tuiMode = "fullscreen";
      quietStartup = true;
      collapseChangelog = true;
      # Restore the previous screen on exit instead of dumping the transcript.
      fullscreenExitOutput = "resume-hint";
    };

    keybindings = {
      "app.editor.external" = [ "alt+e" ];
      # Ctrl+P opens the command palette extension; Pi reserves model-cycling keys
      # against extension shortcuts, so cycling moves to Shift+Ctrl+P.
      "app.model.cycleForward" = [ "shift+ctrl+p" ];
      "app.model.cycleBackward" = [ ];
      # Ctrl+T opens the session tree extension; thinking blocks toggle from the
      # command palette, which sends this chord because Pi exposes no API for it.
      "app.thinking.toggle" = [ "shift+ctrl+alt+t" ];
    };
  };
}

{
  programs.claude-code = {
    enable = true;

    settings = {
      env = {
        CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1";
        CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING = "1";
        CLAUDE_CODE_WORKFLOWS = "1";
      };

      permissions = {
        allow = [ ];
        ask = [ "Bash(dangerouslyDisableSandbox:true)" ];
        defaultMode = "auto";
      };

      sandbox = {
        enabled = true;
        failIfUnavailable = true;
      };

      model = "claude-fable-5[1m]";
      worktree.baseRef = "fresh";

      enabledPlugins = {
        "code-review@claude-plugins-official" = true;
        "obsidian@obsidian-skills" = true;
        "feature-dev@claude-plugins-official" = false;
        "pr-review-toolkit@claude-plugins-official" = true;
        "explanatory-output-style@claude-plugins-official" = true;
        "atomic-agents@claude-plugins-official" = true;
        "code-simplifier@claude-plugins-official" = false;
        "skill-creator@claude-plugins-official" = true;
        "typescript-lsp@claude-plugins-official" = true;
        "rust-analyzer-lsp@claude-plugins-official" = true;
        "codex@openai-codex" = true;
      };

      extraKnownMarketplaces = {
        obsidian-skills.source = {
          source = "github";
          repo = "kepano/obsidian-skills";
        };
        openai-codex.source = {
          source = "github";
          repo = "openai/codex-plugin-cc";
        };
      };

      effortLevel = "medium";
      tui = "fullscreen";
      autoDreamEnabled = true;
      skipDangerousModePermissionPrompt = true;
      skipWorkflowUsageWarning = true;
      theme = "dark-ansi";
      remoteControlAtStartup = true;
      agentPushNotifEnabled = true;
      skipAutoPermissionPrompt = true;
      attributions = {
        commit = "";
        pr = "";
      };
    };
  };
}

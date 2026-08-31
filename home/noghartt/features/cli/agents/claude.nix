{
  config,
  lib,
  pkgs,
  ...
}:
let
  jsonFormat = pkgs.formats.json { };

  # These top-level keys remain Nix-owned. Claude and setup tools may add
  # other keys (notably hooks) directly to the writable runtime file.
  settings = {
    env = {
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = "1";
      CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING = "1";
      CLAUDE_CODE_WORKFLOWS = "1";
    };

    permissions = {
      allow = [ ];
      ask = [ ];
      defaultMode = "auto";
    };

    sandbox.enabled = false;

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

  baseline = jsonFormat.generate "claude-code-settings-baseline.json" (
    settings
    // {
      "$schema" = "https://json.schemastore.org/claude-code-settings.json";
    }
  );

  settingsPath = "${config.home.homeDirectory}/.claude/settings.json";
  baselineStatePath = "${config.xdg.stateHome}/nixcfg/claude-settings-baseline.json";
in
{
  programs.claude-code.enable = true;

  # The upstream HM module links settings.json into the read-only Nix store.
  # Materialize it instead so Claude setup tools can inject runtime-only keys.
  # Keys present in the previous baseline are replaced from Nix on activation;
  # unrelated keys are retained.
  home.activation.mergeClaudeSettings = lib.hm.dag.entryAfter [ "linkGeneration" ] ''
    settings_path=${lib.escapeShellArg settingsPath}
    state_path=${lib.escapeShellArg baselineStatePath}
    settings_dir="$(dirname "$settings_path")"
    state_dir="$(dirname "$state_path")"

    mkdir -p "$settings_dir" "$state_dir"
    current="$(mktemp "$settings_dir/.settings-current.XXXXXX")"
    old_baseline="$(mktemp "$state_dir/.baseline-old.XXXXXX")"
    merged="$(mktemp "$settings_dir/.settings-merged.XXXXXX")"
    trap 'rm -f "$current" "$old_baseline" "$merged"' EXIT

    if [ -r "$settings_path" ]; then
      cp -L "$settings_path" "$current"
    else
      printf '{}\n' > "$current"
    fi

    if ! ${lib.getExe pkgs.jq} -e 'type == "object"' "$current" >/dev/null; then
      echo "Claude settings are not a JSON object: $settings_path" >&2
      exit 1
    fi

    if [ -r "$state_path" ]; then
      cp "$state_path" "$old_baseline"
    else
      printf '{}\n' > "$old_baseline"
    fi

    ${lib.getExe pkgs.jq} \
      --slurpfile old "$old_baseline" \
      --slurpfile baseline ${lib.escapeShellArg baseline} \
      '(reduce ($old[0] | keys[]) as $key (.; del(.[$key]))) * $baseline[0]' \
      "$current" > "$merged"

    if [ -L "$settings_path" ] || ! cmp -s "$merged" "$settings_path"; then
      chmod 600 "$merged"
      mv -f "$merged" "$settings_path"
    fi

    install -m 600 ${lib.escapeShellArg baseline} "$state_path"

    rm -f "$current" "$old_baseline" "$merged"
    trap - EXIT
  '';
}

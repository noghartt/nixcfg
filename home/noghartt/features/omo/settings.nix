{ startupModel }:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  jsonFormat = pkgs.formats.json { };
  pi = config.programs.pi-coding-agent;

  # OmO adopted Pi's settings once when its agent dir was created, which froze
  # Pi's extension and skill store paths into a file nothing refreshed. These
  # keys now follow Pi's on every activation; OmO keeps the rest of the file
  # (model picks, thinking levels, changelog state) because it rewrites it.
  baseline = jsonFormat.generate "omo-settings-baseline.json" {
    # pi-workflows registers a `workflow` tool that collides with omo.js's own,
    # so it fails to load under OmO.
    packages =
      builtins.filter (p: lib.getName p != "pi-workflows") pi.settings.packages
      ++ import ./extensions { inherit lib pkgs; };
    # The Cua Driver skill duplicates OmO's native `computer` tool; with both,
    # two computer-use skills would compete for the same requests.
    skills = builtins.filter (s: baseNameOf s != "cua-driver") pi.settings.skills;
    inherit (pi.settings)
      tuiMode
      quietStartup
      collapseChangelog
      fullscreenExitOutput
      ;
    # OmO-only: the rotating startup and working-status tips.
    tips = false;
    # Keep the interactive picker on the five current Claude and ChatGPT models.
    # Claude Haiku 4.5 is left out of the catalog: it is a generation behind.
    defaultProvider = startupModel.provider;
    defaultModel = startupModel.model;
    defaultThinkingLevel = startupModel.thinking;
    enabledModels = [
      "anthropic-subscription/claude-opus-5-5"
      "anthropic-subscription/claude-sonnet-5-5"
      "anthropic-subscription/claude-fable-5-1"
      "chatgpt-subscription/gpt-6-astra"
      "chatgpt-subscription/gpt-6-sol"
    ];
  };

  settingsPath = "${config.home.homeDirectory}/.omo/agent/settings.json";
  baselineStatePath = "${config.xdg.stateHome}/nixcfg/omo-settings-baseline.json";
in
{
  home.file.".omo/agent/keybindings.json".source =
    jsonFormat.generate "omo-keybindings.json" pi.keybindings;

  # Same merge as Claude's settings: keys in the previous baseline are replaced
  # from Nix, unrelated keys are retained.
  home.activation.mergeOmoSettings = lib.hm.dag.entryAfter [ "linkGeneration" ] ''
    settings_path=${lib.escapeShellArg settingsPath}
    state_path=${lib.escapeShellArg baselineStatePath}
    settings_dir="$(dirname "$settings_path")"
    state_dir="$(dirname "$state_path")"

    mkdir -p "$settings_dir" "$state_dir"
    current="$(mktemp "$settings_dir/.settings-current.XXXXXX")"
    old_baseline="$(mktemp "$state_dir/.omo-baseline-old.XXXXXX")"
    merged="$(mktemp "$settings_dir/.settings-merged.XXXXXX")"
    trap 'rm -f "$current" "$old_baseline" "$merged"' EXIT

    if [ -r "$settings_path" ]; then
      cp -L "$settings_path" "$current"
    else
      printf '{}\n' > "$current"
    fi

    if ! ${lib.getExe pkgs.jq} -e 'type == "object"' "$current" >/dev/null; then
      echo "OmO settings are not a JSON object: $settings_path" >&2
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
      chmod 644 "$merged"
      mv -f "$merged" "$settings_path"
    fi

    install -m 644 ${lib.escapeShellArg baseline} "$state_path"

    rm -f "$current" "$old_baseline" "$merged"
    trap - EXIT
  '';
}

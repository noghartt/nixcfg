{
  config,
  lib,
  pkgs,
  agentPath,
  ...
}:
let
  # Same path the upstream module links when it has settings to write.
  configFile = ".codex/config.toml";
  hasNixConfig = config.programs.codex.settings != { };
  configPath = "${config.home.homeDirectory}/${configFile}";
  baselineStatePath = "${config.xdg.stateHome}/nixcfg/codex-config-baseline.json";
  jq = lib.getExe pkgs.jq;
  remarshal = lib.getExe pkgs.remarshal;
in
{
  config = lib.mkMerge [
    {
      programs.codex = {
        enable = true;
        package = agentPath.wrap pkgs.codex;
      };
    }
    (lib.mkIf hasNixConfig {
      # The upstream module links config.toml into the read-only Nix store, but Codex
      # writes runtime state there (project trust, plugins, hook state), so trusting a
      # folder fails. Materialize it instead: leaves owned by the previous Nix
      # baseline are dropped, the current baseline is merged in, everything else stays.
      home.file.${configFile}.enable = lib.mkForce false;

      home.activation.mergeCodexConfig = (
        lib.hm.dag.entryAfter [ "linkGeneration" ] ''
          config_path=${lib.escapeShellArg configPath}
          state_path=${lib.escapeShellArg baselineStatePath}
          config_dir="$(dirname "$config_path")"
          state_dir="$(dirname "$state_path")"

          mkdir -p "$config_dir" "$state_dir"
          current="$(mktemp "$config_dir/.config-current.XXXXXX")"
          baseline="$(mktemp "$state_dir/.codex-baseline.XXXXXX")"
          old_baseline="$(mktemp "$state_dir/.codex-baseline-old.XXXXXX")"
          merged="$(mktemp "$config_dir/.config-merged.XXXXXX")"
          trap 'rm -f "$current" "$baseline" "$old_baseline" "$merged" "$merged.toml"' EXIT

          if [ -r "$config_path" ]; then
            ${remarshal} --if toml --of json "$config_path" "$current"
          else
            printf '{}\n' > "$current"
          fi

          ${remarshal} --if toml --of json \
            ${config.home.file.${configFile}.source} "$baseline"

          if [ -r "$state_path" ]; then
            cp "$state_path" "$old_baseline"
          else
            printf '{}\n' > "$old_baseline"
          fi

          # Codex's tables nest (mcp_servers.<name>), so ownership is per leaf rather
          # than per top-level key: a server added by hand survives next to Nix's.
          ${jq} --slurpfile old "$old_baseline" --slurpfile new "$baseline" '
            def leaves: to_entries[] | .key as $k
              | if (.value | type) == "object" and (.value | length) > 0
                then .value | leaves | [$k] + .
                else [$k] end;
            def tables: to_entries[] | select(.value | type == "object") | .key as $k
              | (.value | tables | [$k] + .), [$k];
            reduce ($old[0] | leaves) as $p (.; delpaths([$p]))
            | reduce ($old[0] | tables) as $p (.; if getpath($p) == {} then delpaths([$p]) else . end)
            | . * $new[0]
          ' "$current" > "$merged"

          if [ -L "$config_path" ] || ! ${jq} -e --slurpfile a "$merged" '. == $a[0]' "$current" >/dev/null; then
            ${remarshal} --if json --of toml "$merged" "$merged.toml"
            chmod 600 "$merged.toml"
            mv -f "$merged.toml" "$config_path"
          fi

          install -m 600 "$baseline" "$state_path"

          rm -f "$current" "$baseline" "$old_baseline" "$merged" "$merged.toml"
          trap - EXIT
        ''
      );
    })
  ];
}

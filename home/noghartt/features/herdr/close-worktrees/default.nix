{
  config,
  lib,
  pkgs,
  ...
}:
let
  closeWorktrees = pkgs.runCommand "herdr-close-worktrees-0.1.0" { } ''
    mkdir -p "$out"
    cp ${./herdr-plugin.toml} "$out/herdr-plugin.toml"
    cp ${./close-worktrees.sh} "$out/close-worktrees.sh"
    cat > "$out/launch.sh" <<'EOF'
    #!${pkgs.runtimeShell}
    export PATH="${lib.makeBinPath [ pkgs.jq ]}:$PATH"
    exec ${pkgs.runtimeShell} "$HERDR_PLUGIN_ROOT/close-worktrees.sh"
    EOF
    substituteInPlace "$out/herdr-plugin.toml" \
      --replace-fail '"sh"' '"${pkgs.runtimeShell}"' \
      --replace-fail 'exec sh ' 'exec ${pkgs.runtimeShell} '
  '';
in
{
  # The activation reference retains this bundle without merging its manifest
  # into the user profile, where it would collide with other Herdr plugins.
  home.activation.linkHerdrCloseWorktrees = lib.hm.dag.entryAfter [ "linkGeneration" ] ''
    $DRY_RUN_CMD ${lib.getExe config.programs.herdr.package} plugin link ${closeWorktrees} >/dev/null
  '';

  # Sits beside close_workspace (prefix+shift+d); behind the prefix because it
  # closes several workspaces at once, even though the popup asks first.
  programs.herdr.settings.keys.command = [
    {
      key = "prefix+alt+d";
      type = "plugin_action";
      command = "nixcfg.close-worktrees.open";
      description = "close the repository's worktree workspaces";
    }
  ];
}

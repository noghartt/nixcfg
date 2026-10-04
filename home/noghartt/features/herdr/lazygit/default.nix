{
  config,
  lib,
  pkgs,
  ...
}:
let
  herdr = lib.getExe config.programs.herdr.package;
  lazygit = pkgs.runCommand "herdr-lazygit-0.1.0" { } ''
    mkdir -p "$out"
    cp ${./herdr-plugin.toml} "$out/herdr-plugin.toml"
    cat > "$out/launch.sh" <<'EOF'
    #!${pkgs.runtimeShell}
    # Plugin processes start in the plugin root with a minimal PATH; the user's profile
    # comes first so lazygit sees the same git, editor, and pager as an interactive shell.
    export PATH="$HOME/.nix-profile/bin:/etc/profiles/per-user/$(id -un)/bin:/run/current-system/sw/bin:${
      lib.makeBinPath [
        pkgs.git
        pkgs.jq
      ]
    }:$PATH"
    # A popup has no pane of its own; the context names the tiled pane beneath it.
    dir=$(printf '%s' "''${HERDR_PLUGIN_CONTEXT_JSON:-}" |
      jq -r '.focused_pane_cwd // .worktree.checkout_path // .workspace_cwd // empty')
    cd "''${dir:-$HOME}" || exit 1
    exec ${lib.getExe pkgs.lazygit}
    EOF
    substituteInPlace "$out/herdr-plugin.toml" \
      --replace-fail '"sh"' '"${pkgs.runtimeShell}"' \
      --replace-fail 'exec sh ' 'exec ${pkgs.runtimeShell} '
  '';
in
{
  # The activation reference retains this bundle without merging its manifest
  # into the user profile, where it would collide with other Herdr plugins.
  # Unlinking reviewr drops its registration, which pointed into a store path
  # that is no longer retained.
  home.activation.linkHerdrLazygit = lib.hm.dag.entryAfter [ "linkGeneration" ] ''
    $DRY_RUN_CMD ${herdr} plugin unlink persiyanov.reviewr >/dev/null 2>&1 || true
    $DRY_RUN_CMD ${herdr} plugin link ${lazygit} >/dev/null
  '';

  programs.herdr.settings.keys.command = [
    {
      key = "alt+r";
      type = "plugin_action";
      command = "nixcfg.lazygit.open";
      description = "lazygit for the focused repository";
    }
  ];
}

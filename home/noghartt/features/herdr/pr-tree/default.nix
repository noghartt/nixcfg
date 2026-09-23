{
  config,
  lib,
  pkgs,
  ...
}:
let
  runtimePath = lib.makeBinPath (
    [ pkgs.gh ]
    ++ lib.optionals pkgs.stdenv.hostPlatform.isLinux [
      pkgs.wl-clipboard
      pkgs.xclip
      pkgs.xdg-utils
    ]
  );
  prTree = pkgs.runCommand "herdr-pr-tree-0.1.0" { } ''
    mkdir -p "$out"
    cp ${./herdr-plugin.toml} "$out/herdr-plugin.toml"
    cp ${./pr_tree.py} "$out/pr_tree.py"
    cat > "$out/launch.sh" <<'EOF'
    #!${pkgs.runtimeShell}
    export PATH="${runtimePath}:$PATH"
    exec ${lib.getExe pkgs.python3} "$HERDR_PLUGIN_ROOT/pr_tree.py"
    EOF
    substituteInPlace "$out/herdr-plugin.toml" \
      --replace-fail '"sh"' '"${pkgs.runtimeShell}"' \
      --replace-fail 'exec sh ' 'exec ${pkgs.runtimeShell} '
  '';
in
{
  # The activation reference retains this bundle without merging its manifest
  # into the user profile, where it would collide with other Herdr plugins.
  home.activation.linkHerdrPrTree = lib.hm.dag.entryAfter [ "linkGeneration" ] ''
    $DRY_RUN_CMD ${lib.getExe config.programs.herdr.package} plugin link ${prTree} >/dev/null
  '';

  programs.herdr.settings.keys.command = [
    {
      key = "alt+p";
      type = "plugin_action";
      command = "nixcfg.pr-tree.open";
      description = "my open pull requests";
    }
  ];
}

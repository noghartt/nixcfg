# Agents may only draft GitHub comments and reviews; the gh shim refuses to
# post them. Harness binaries are wrapped so only their process trees see the
# shim first on PATH, while the interactive shell keeps the real gh.
{
  config,
  lib,
  pkgs,
  ...
}:
let
  binDir = "${config.home.homeDirectory}/.agents/bin";
  prependPath = ''export PATH=${lib.escapeShellArg binDir}"''${PATH:+:$PATH}"'';
  wrap =
    pkg:
    let
      main = pkg.meta.mainProgram;
      wrapper = pkgs.writeShellScript "${main}-agent-path" ''
        ${prependPath}
        exec -a "$0" ${lib.getExe pkg} "$@"
      '';
    in
    pkgs.symlinkJoin {
      name = "${lib.getName pkg}-agent-path-${lib.getVersion pkg}";
      # HM modules gate features on the version and read meta (mainProgram).
      inherit (pkg) version meta;
      paths = [ pkg ];
      postBuild = ''
        rm "$out/bin/${main}"
        cp ${wrapper} "$out/bin/${main}"
      '';
    };
in
{
  _module.args.agentPath = { inherit prependPath wrap; };

  home.file.".agents/bin/gh" = {
    source = ./gh-shim.sh;
    executable = true;
  };
}

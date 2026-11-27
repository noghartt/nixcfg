# pi-durable runs against the installed Pi package itself: Node 24 strips the
# TypeScript, bare imports resolve through Pi's node_modules and `#pi/*`
# (package.json `imports`) through Pi's dist, both by symlink, so there is no
# npm build and Durable is always the copy shipped with `pi`.
{
  lib,
  stdenvNoCC,
  makeBinaryWrapper,
  nodejs_24,
  pi-coding-agent,
  ripgrep,
  fd,
  git-twig,
}:
let
  pi = "${pi-coding-agent}/lib/node_modules/pi-monorepo";
  # Durable's API changes between releases and the TUI uses some of pi's
  # internal modules; the port is checked against this Pi only.
  verifiedPiVersion = "1.6.0";
  modules = [
    "main"
    "runtime"
    "tui"
    "resources"
    "sessions"
    "dashboard"
    "state"
    "host"
    "profiles"
    "worktrees"
    "subagent"
    "watch"
    "messaging"
    "antigravity"
    "approvals"
    "prompt"
    "harness-setup"
    "completions"
    "rex"
    "branches"
    "spill"
    "swarm"
    "swarm-board"
    "research"
    "btw"
    "status"
    "limits"
    "accounts"
    "accounts-view"
    "accounts-cli"
  ];
in
stdenvNoCC.mkDerivation {
  pname = "pi-durable";
  inherit (pi-coding-agent) version;
  src = ./src;

  nativeBuildInputs = [ makeBinaryWrapper ];

  installPhase = ''
    runHook preInstall

    lib="$out/lib/pi-durable"
    mkdir -p "$lib" "$out/bin"
    cp ./*.ts package.json "$lib/"
    # /status reads subscription limits through the statusline's fetcher and its shared cache.
    cp ${../pi/extensions/statusline/limits.ts} "$lib/limits.ts"
    rm -f "$lib"/*.d.ts
    # Symlinks, so Node's realpath module cache shares one copy of every module with pi.
    ln -s ${pi}/node_modules "$lib/node_modules"
    ln -s ${pi}/dist "$lib/pi"

    makeWrapper ${lib.getExe nodejs_24} "$out/bin/pi-durable" \
      --add-flags "--disable-warning=ExperimentalWarning $lib/main.ts" \
      --prefix PATH : ${
        lib.makeBinPath [
          ripgrep
          fd
          git-twig
        ]
      } \
      --set-default PI_SKIP_VERSION_CHECK 1 \
      --set-default PI_TELEMETRY 0

    runHook postInstall
  '';

  # Importing every module links each import against Pi's exports, so a Pi that
  # moved something fails here rather than at the first prompt.
  doInstallCheck = true;
  installCheckPhase = ''
    runHook preInstallCheck
    export HOME="$TMPDIR"
    "$out/bin/pi-durable" --version | grep -qx ${lib.escapeShellArg pi-coding-agent.version}
    ${lib.getExe nodejs_24} --disable-warning=ExperimentalWarning --input-type=module -e "
      for (const file of [${lib.concatMapStringsSep ", " (m: "'${m}'") (lib.remove "main" modules)}])
        await import('$out/lib/pi-durable/' + file + '.ts');
    "
    # Tests run beside the installed modules (linked, so they resolve Pi the same way) on a
    # throwaway agent dir, and are not installed themselves.
    check="$TMPDIR/pi-durable-tests"
    mkdir -p "$check"
    ln -s "$out"/lib/pi-durable/* "$check/"
    cp ${./tests}/*.test.ts "$check/"
    PI_CODING_AGENT_DIR="$TMPDIR/agent" ${lib.getExe nodejs_24} --disable-warning=ExperimentalWarning \
      --test "$check"/*.test.ts
    runHook postInstallCheck
  '';

  meta = {
    description = "Durable coding agent with pi's TUI, built on Pi Durable";
    license = lib.licenses.mit;
    mainProgram = "pi-durable";
    # Re-port when nixpkgs moves Pi on (docs/pi-durable.md).
    broken = pi-coding-agent.version != verifiedPiVersion;
  };
}

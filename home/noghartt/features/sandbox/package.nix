# sbx runs its TypeScript directly on Node 24 (native type stripping), so there
# is no npm build: the only dependency, the exe.dev SDK, is vendored from its
# npm tarball (MIT, no dependencies of its own).
{
  lib,
  stdenvNoCC,
  fetchurl,
  makeBinaryWrapper,
  nodejs_24,
  git,
  openssh,
  coreutils,
}:
let
  sdk = fetchurl {
    url = "https://registry.npmjs.org/@exedev/sdk/-/sdk-0.7.0.tgz";
    hash = "sha256-3/bgRXzp5qR4pN8akYBvz1vN2giFFmIwKI81OkFF860=";
  };
  node = lib.getExe nodejs_24;
in
stdenvNoCC.mkDerivation {
  pname = "sbx";
  version = "0.1.0";
  src = lib.fileset.toSource {
    root = ./.;
    fileset = lib.fileset.unions [
      ./src
      ./tests
    ];
  };

  nativeBuildInputs = [ makeBinaryWrapper ];

  installPhase = ''
    runHook preInstall

    lib="$out/lib/sbx"
    mkdir -p "$lib/node_modules/@exedev/sdk" "$out/bin"
    cp -r src/. "$lib/"
    tar -xzf ${sdk} -C "$lib/node_modules/@exedev/sdk" --strip-components=1

    # The user's git and ssh come first: sbx bundles their checkouts and opens
    # shells with their ssh config; ours only fill in where none is installed.
    makeWrapper ${node} "$out/bin/sbx" \
      --add-flags "--disable-warning=ExperimentalWarning $lib/cli.ts" \
      --suffix PATH : ${
        lib.makeBinPath [
          git
          openssh
        ]
      }

    runHook postInstall
  '';

  # Tests run against the installed tree (so they see the vendored SDK as sbx
  # does) from a scratch dir laid out like the source; they are not installed.
  doInstallCheck = true;
  nativeInstallCheckInputs = [
    git
    openssh
    coreutils
  ];
  installCheckPhase = ''
    runHook preInstallCheck
    export HOME="$TMPDIR/home" XDG_CONFIG_HOME="$TMPDIR/config" XDG_STATE_HOME="$TMPDIR/state"
    mkdir -p "$HOME"
    check="$TMPDIR/sbx-tests"
    mkdir -p "$check"
    ln -s "$out/lib/sbx" "$check/src"
    ln -s "$out/lib/sbx/node_modules" "$check/node_modules"
    cp -r tests "$check/tests"
    ${node} --disable-warning=ExperimentalWarning --test "$check"/tests/*.test.ts
    "$out/bin/sbx" help >/dev/null
    runHook postInstallCheck
  '';

  meta = {
    description = "Provider-agnostic sandboxes for agents and jobs, on exe.dev first";
    license = lib.licenses.mit;
    mainProgram = "sbx";
  };
}

{
  fetchurl,
  makeBinaryWrapper,
  stdenvNoCC,
}:
stdenvNoCC.mkDerivation {
  pname = "leverage";
  version = "0.2.108";

  # Upstream only serves a moving `stable` channel (a redirect to a presigned
  # R2 URL), so this hash pins whatever build was current at the last bump.
  # Bump: download the URL, check `--version`, update version and hash.
  src = fetchurl {
    name = "leverage-darwin-arm64";
    url = "https://app.leverage.computer/api/cli/download?os=darwin&arch=arm64";
    hash = "sha256-QJ6QowORndzfd5KZhotez8qJlzMWH0Ig9CnqSfPz9ek=";
  };

  nativeBuildInputs = [ makeBinaryWrapper ];

  dontUnpack = true;
  # A Bun-compiled executable: the bundle trails the Mach-O and the ad-hoc
  # signature covers it, so stripping or rewriting it breaks the binary.
  dontFixup = true;

  # The background self-updater would try to replace the store binary;
  # updates come from bumping this file.
  installPhase = ''
    runHook preInstall
    install -Dm755 $src $out/libexec/leverage
    makeBinaryWrapper $out/libexec/leverage $out/bin/leverage \
      --set LEVERAGE_NO_AUTO_UPDATE 1 \
      --set LEVERAGE_DISABLE_SELF_UPDATE 1
    runHook postInstall
  '';

  meta = {
    mainProgram = "leverage";
    platforms = [ "aarch64-darwin" ];
  };
}

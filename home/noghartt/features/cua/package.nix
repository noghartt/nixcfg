{
  fetchFromGitHub,
  fetchurl,
  stdenvNoCC,
}:
stdenvNoCC.mkDerivation (finalAttrs: {
  pname = "cua-driver";
  version = "0.33.1";

  src = fetchurl {
    url = "https://github.com/trycua/cua/releases/download/cua-driver-rs-v${finalAttrs.version}/cua-driver-rs-${finalAttrs.version}-darwin-arm64.tar.gz";
    hash = "sha256-ozwvRZV0nRRN0PNMkG8YMJYQuZiVC81MFIlWMKtLyMY=";
  };

  # macOS keys the Accessibility and Screen Recording grants on the notarized
  # bundle's signature, so the app must reach the store byte-identical.
  dontConfigure = true;
  dontBuild = true;
  dontFixup = true;

  installPhase = ''
    runHook preInstall
    mkdir -p $out/Applications
    cp -R CuaDriver.app $out/Applications/
    runHook postInstall
  '';

  # The upstream skill is versioned with the driver; pinning both to one tag
  # keeps its tool names and arguments in step with the binary.
  passthru.skill = "${
    fetchFromGitHub {
      owner = "trycua";
      repo = "cua";
      tag = "cua-driver-rs-v${finalAttrs.version}";
      sparseCheckout = [ "libs/cua-driver/rust/Skills/cua-driver" ];
      hash = "sha256-3VwI8dYtZSXGagfPCCrhlbH6sQFfIYNBFhDC5VOfP3Q=";
    }
  }/libs/cua-driver/rust/Skills/cua-driver";

  meta.platforms = [ "aarch64-darwin" ];
})

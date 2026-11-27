{
  fetchFromGitHub,
  lib,
  rustPlatform,
  sqlite,
}:
rustPlatform.buildRustPackage (finalAttrs: {
  pname = "hashcards";
  version = "0.5.0";

  src = fetchFromGitHub {
    owner = "eudoxia0";
    repo = "hashcards";
    tag = "v${finalAttrs.version}";
    hash = "sha256-XX3j5ljOpyIxFJq3NPAM7ZPGoc33BH0bGOFMzJJ7XEg=";
  };

  cargoHash = "sha256-CK4k8etB4MZUkJWk/OabuBuIN+AkT/GulsYS1Qa7NVE=";

  buildInputs = [ sqlite ];

  # The suite starts HTTP servers on picked ports, which the Darwin build
  # sandbox refuses; upstream's own flake skips it too.
  doCheck = false;

  meta = {
    description = "Plain text-based spaced repetition system";
    homepage = "https://github.com/eudoxia0/hashcards";
    license = lib.licenses.asl20;
    mainProgram = "hashcards";
  };
})

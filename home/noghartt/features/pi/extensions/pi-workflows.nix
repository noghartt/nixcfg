{
  lib,
  pkgs,
  ...
}:
let
  piWorkflows = pkgs.buildNpmPackage {
    pname = "pi-workflows";
    version = "0.15.3";

    src = pkgs.fetchFromGitHub {
      owner = "osolmaz";
      repo = "pi-workflows";
      rev = "0c301befa45efa5eb91c0badaa06cbdc0fb0b756";
      hash = "sha256-DQig93k7SMwU5KO7YkpwRLyAji/IuwZfJ5cXhVflOaE=";
    };

    npmDepsFetcherVersion = 2;
    npmDepsHash = "sha256-nkHIv804XY6vXofU3PSF2r8AHF2qxf26varY3Q0b3E4=";

    # The release lock omits integrity hashes from nested Pi development packages.
    prePatch = ''
      ${lib.getExe pkgs.jq} '
        def integrities: {
          "pi-agent-core": "sha512-8Pn3wSCxj0cfo5I6jxQYVB/3uuQRmHhAlEclyjqpOuMEdQMIODHizRogv56FLdbU+dTiGnybeHQ2N+sV1/L2YA==",
          "pi-ai": "sha512-6MzsrYIYNVlE7SfpbL2yYb67Qo58p/7Q+xWG1RZvoX1P80aRCHSod2/13aFpxkow1lPO2LEh3c495J0Gwmyjig==",
          "pi-client": "sha512-/RFSPhD/bZbpOp1oJj+UneSUFSgZhWxzcSENUY+8+8xhoBrWXMYI2t77XNx4Yf+c8YK2qTHquForhNcelYpXvg==",
          "pi-protocol": "sha512-jbBh03fkeckWEroHpcZBr4w5/Ibat8WwdXFlXHivYQImrQNFtLpDeL0t1cku4hmK0q3pceIRQHkw4fwbM4YILQ==",
          "pi-telemetry": "sha512-wg5caea7uIv1BHRBm2Y116RvFG4oSAiP5qk9tA2463PDGIr4K8M1Ceyyg5DOpF/shUUl0gk826yQJAeAcHYB9g==",
          "pi-tui": "sha512-ds2TLihOnM5sLJB3VpXV6y0uR5efVuHf4MN7yDpsty6hA2DUO/EDVzjp/0od0G2JslzVLMjT8T8zavtxVb+qbg=="
        };
        .packages |= with_entries(
          if (.value.resolved and (.value.integrity | not))
          then .value.integrity = integrities[.key | split("/")[-1]]
          else .
          end
        )
      ' package-lock.json > fixed-package-lock.json
      mv fixed-package-lock.json package-lock.json
    '';

    postBuild = ''
      ${lib.getExe pkgs.jq} '.pi.extensions = ["./dist/extension/index.js"]' package.json > fixed-package.json
      mv fixed-package.json package.json
    '';

    installPhase = ''
      runHook preInstall
      npm prune --omit=dev --ignore-scripts
      mkdir -p $out
      cp -r . $out/
      runHook postInstall
    '';
  };
in
{
  programs.pi-coding-agent.settings.packages = [ piWorkflows ];
}

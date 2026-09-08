{
  flake,
  lib,
  pkgs,
  ...
}:
let
  version = "0.36.2";
  system = pkgs.stdenv.hostPlatform.system;
  targets = {
    aarch64-darwin = {
      name = "aarch64-apple-darwin";
      hash = "sha256-gf1BcymDZ8D1LZaeE7LB7vj1Qx2CUFNJegVs7bjR8mE=";
    };
    x86_64-darwin = {
      name = "x86_64-apple-darwin";
      hash = "sha256-r2vbg4/yvVC3a8NnkxVPt/OzUMP4BFp5LVjkSX8blTA=";
    };
    aarch64-linux = {
      name = "aarch64-unknown-linux-musl";
      hash = "sha256-8c3hLNYiSK03XQz2i44WCVAD+ul/I62jQZmmtl3aX/4=";
    };
    x86_64-linux = {
      name = "x86_64-unknown-linux-musl";
      hash = "sha256-P1mWvp+9ie3LlN5MMlZIPkpsopxA+YHhUFVBWQtYKX8=";
    };
  };
  target = targets.${system} or (throw "herdr-reviewr: unsupported system ${system}");
  source = pkgs.fetchurl {
    url = "https://github.com/persiyanov/herdr-reviewr/archive/refs/tags/v${version}.tar.gz";
    hash = "sha256-9XeDNReOnWTBKkLoV7asfT8hHtIgiHB+W86TyUeHo5U=";
  };
  binary = pkgs.fetchurl {
    url = "https://github.com/persiyanov/herdr-reviewr/releases/download/v${version}/herdr-reviewr-${target.name}.tar.gz";
    inherit (target) hash;
  };
  reviewr = pkgs.stdenvNoCC.mkDerivation {
    pname = "herdr-reviewr";
    inherit version;
    src = source;

    dontFixup = true;

    installPhase = ''
      runHook preInstall

      mkdir -p "$out/bin"
      cp herdr-plugin.toml "$out/"
      cp -R herdr "$out/"
      tar -xzf ${binary} -C "$out/bin" herdr-reviewr

      substituteInPlace "$out/herdr-plugin.toml" \
        --replace-fail 'command = ["bash"' 'command = ["${pkgs.runtimeShell}"' \
        --replace-fail 'command = ["sh"' 'command = ["${pkgs.runtimeShell}"'
      substituteInPlace "$out/herdr/pane.sh" \
        --replace-fail 'export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:''${PATH:-}"' \
          'export PATH="${
            lib.makeBinPath [
              pkgs.coreutils
              pkgs.git
              pkgs.jq
              pkgs.gnused
            ]
          }:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:''${PATH:-}"'

      runHook postInstall
    '';

    meta = {
      description = "Code-review pane for Herdr";
      homepage = "https://github.com/persiyanov/herdr-reviewr";
      license = lib.licenses.mit;
      mainProgram = "herdr-reviewr";
      platforms = builtins.attrNames targets;
    };
  };
  herdr = flake.inputs.herdr.packages.${system}.default;
in
{
  home.packages = [ reviewr ];

  # Herdr has no Home Manager plugin option, but `plugin link` can register an
  # immutable local plugin while its writable config and state remain outside Nix.
  home.activation.linkHerdrReviewr = lib.hm.dag.entryAfter [ "linkGeneration" ] ''
    $DRY_RUN_CMD ${lib.getExe herdr} plugin link ${lib.escapeShellArg reviewr} >/dev/null
  '';
}

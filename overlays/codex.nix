_: prev:
let
  version = "0.153.2";
  platform = prev.stdenv.hostPlatform.system;
  releases = {
    x86_64-linux = {
      target = "x86_64-unknown-linux-musl";
      hash = "sha256-6M0RYAcfcl0qEMq4EHPdaBj8iwljchJdJ+9uZv3wl54=";
      codeModeHostHash = "sha256-F3pFB7nMf5fxE6wDRpezn2pxqHaovVCP9tf1LzQuvko=";
    };
    aarch64-darwin = {
      target = "aarch64-apple-darwin";
      hash = "sha256-kd/CcPDfuuwW2BTxqpDU8n503J43hOZABr7zt5/p4Jw=";
      codeModeHostHash = "sha256-NHHlSmFB+8vpTOyH0UNwNTZn1A81DvFvqgBevBhUMAs=";
    };
  };
  release = releases.${platform} or (throw "Codex ${version} is not packaged for ${platform}");
in
{
  codex = prev.stdenvNoCC.mkDerivation {
    pname = "codex";
    inherit version;

    src = prev.fetchurl {
      url = "https://github.com/openai/codex/releases/download/rust-v${version}/codex-${release.target}.tar.gz";
      inherit (release) hash;
    };

    # Codex resolves codex-code-mode-host next to its own binary; without it
    # code mode fails closed.
    codeModeHostSrc = prev.fetchurl {
      url = "https://github.com/openai/codex/releases/download/rust-v${version}/codex-code-mode-host-${release.target}.tar.gz";
      hash = release.codeModeHostHash;
    };

    dontUnpack = true;
    nativeBuildInputs = [
      prev.installShellFiles
      prev.makeWrapper
    ];

    installPhase = ''
      runHook preInstall

      mkdir -p "$out/bin"
      tar -xzf "$src"
      install -Dm755 "codex-${release.target}" "$out/bin/codex"
      tar -xzf "$codeModeHostSrc"
      install -Dm755 "codex-code-mode-host-${release.target}" "$out/bin/codex-code-mode-host"
      wrapProgram "$out/bin/codex" --prefix PATH : ${
        prev.lib.makeBinPath (
          [ prev.ripgrep ] ++ prev.lib.optional prev.stdenv.hostPlatform.isLinux prev.bubblewrap
        )
      }

      installShellCompletion --cmd codex \
        --bash <("$out/bin/codex" completion bash) \
        --fish <("$out/bin/codex" completion fish) \
        --zsh <("$out/bin/codex" completion zsh)

      runHook postInstall
    '';

    doInstallCheck = true;
    nativeInstallCheckInputs = [ prev.versionCheckHook ];

    meta = prev.codex.meta // {
      changelog = "https://github.com/openai/codex/releases/tag/rust-v${version}";
      platforms = builtins.attrNames releases;
      sourceProvenance = with prev.lib.sourceTypes; [ binaryNativeCode ];
    };
  };
}

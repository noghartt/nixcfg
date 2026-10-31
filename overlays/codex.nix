_: prev:
let
  version = "0.162.0";
  platform = prev.stdenv.hostPlatform.system;
  releases = {
    x86_64-linux = {
      target = "x86_64-unknown-linux-musl";
      hash = "sha256-T1c5RMHSBZEJ11ovTQzJwDaXKIIkpeQHcXqd6Y/AEMU=";
    };
    aarch64-darwin = {
      target = "aarch64-apple-darwin";
      hash = "sha256-WAnukKnDtZ1Di7JmOu+gtD2G+CVDi2XUUEsx+CNDYos=";
    };
  };
  release = releases.${platform} or (throw "Codex ${version} is not packaged for ${platform}");
in
{
  codex = prev.stdenvNoCC.mkDerivation {
    pname = "codex";
    inherit version;

    # The complete release package, not the bare binary: Codex's background
    # app-server daemon refuses to start unless the real executable sits in a
    # package layout (codex-package.json, bin/codex-code-mode-host, codex-path/rg).
    src = prev.fetchurl {
      url = "https://github.com/openai/codex/releases/download/rust-v${version}/codex-package-${release.target}.tar.gz";
      inherit (release) hash;
    };

    dontUnpack = true;
    nativeBuildInputs = [
      prev.installShellFiles
      prev.makeWrapper
    ];

    # The wrapper must exec the packaged binary in place: Codex finds its package
    # from the canonical path of its own executable.
    installPhase = ''
      runHook preInstall

      mkdir -p "$out/libexec/codex"
      tar -xzf "$src" -C "$out/libexec/codex"
      makeWrapper "$out/libexec/codex/bin/codex" "$out/bin/codex" --prefix PATH : ${
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

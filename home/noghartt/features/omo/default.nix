# OmO Native: the standalone `omo` command (a pinned senpi/Pi-fork engine with
# the oh-my-openagent extension built in), kept apart from the Pi feature.
{
  lib,
  pkgs,
  agentPath,
  ...
}:
let
  version = "5.1.28";

  # Every new session starts here: settings.nix seeds it, the launcher restores it.
  startupModel = {
    provider = "anthropic";
    model = "claude-opus-5-5";
    thinking = "high";
  };

  # Release asset and hash per platform; bump every hash with `version`.
  releases = {
    aarch64-darwin = {
      asset = "omo-darwin-arm64";
      hash = "sha256-2s5s1cgQZ0Tw9cOrajVslCcqaGFcMV7fjL2Io+5EECw=";
    };
    # A generic glibc build: it runs on NixOS through nix-ld (mellon's
    # agents.nix). Patching its interpreter would risk the appended payload.
    x86_64-linux = {
      asset = "omo-linux-x64";
      hash = "sha256-oNO209vMY80DtHXpTlqH3XPPk4Cx4052CgDRpZaLG/c=";
    };
  };
  release = releases.${pkgs.stdenv.hostPlatform.system};

  # Linux has what macOS lacks (memwatch.nix): a kernel memory cap. Each
  # session runs in its own transient user scope, throttled past MemoryHigh and
  # OOM-killed past MemoryMax, eval kernels included. Without a user manager
  # (a bare container) it runs uncapped.
  launch =
    if pkgs.stdenv.hostPlatform.isLinux then
      ''
        if [ -S "''${XDG_RUNTIME_DIR:-/nonexistent}/bus" ] && command -v systemd-run >/dev/null; then
          exec systemd-run --user --scope --quiet --collect \
            -p MemoryHigh=12G -p MemoryMax=16G -- ${omo-unwrapped}/bin/omo "$@"
        fi
        exec ${omo-unwrapped}/bin/omo "$@"
      ''
    else
      ''
        exec -a omo ${omo-unwrapped}/bin/omo "$@"
      '';

  # The release binary is bun-compiled and self-contained; it unpacks its
  # runtime into ~/.omo/binary-runtime/<version>/ on first run. `omo update`
  # only prints a curl line for binary installs, so bumping `version` here is
  # the update path.
  omo-unwrapped = pkgs.stdenvNoCC.mkDerivation {
    pname = "omo";
    inherit version;
    src = pkgs.fetchurl {
      url = "https://github.com/code-yeongyu/oh-my-openagent/releases/download/v${version}/${release.asset}";
      inherit (release) hash;
    };
    dontUnpack = true;
    # The bun payload is appended to the executable; stripping would drop it.
    dontStrip = true;
    installPhase = ''
      runHook preInstall
      install -Dm755 $src $out/bin/omo
      runHook postInstall
    '';
    meta = {
      platforms = builtins.attrNames releases;
      mainProgram = "omo";
    };
  };

  # The engine falls back to legacy PI_* variables when OMO_* ones are unset;
  # pinning its agent dir keeps it from ever sharing Pi's settings or sessions.
  # OmO saves every model pick and thinking change as the global default, so one
  # session's switch became every later session's starting model. Each launch
  # restores the startup model; resumed sessions keep their own, and --model wins.
  # Every running session hot-reloads when settings.json changes, and OmO only
  # ignores edits that change routine keys, so a byte-only rewrite (jq's trailing
  # newline) reloaded them all. The file is rewritten only when the bytes differ,
  # serialized like OmO's own writes (no trailing newline).
  omo = pkgs.writeShellScriptBin "omo" ''
    ${agentPath.prependPath}
    export OMO_CODING_AGENT_DIR="''${OMO_CODING_AGENT_DIR:-$HOME/.omo/agent}"
    settings="$OMO_CODING_AGENT_DIR/settings.json"
    if [ -f "$settings" ] && [ ! -L "$settings" ]; then
      tmp="$(mktemp "$settings.XXXXXX")"
      if ${lib.getExe pkgs.jq} \
        --arg provider ${lib.escapeShellArg startupModel.provider} \
        --arg model ${lib.escapeShellArg startupModel.model} \
        --arg thinking ${lib.escapeShellArg startupModel.thinking} \
        '.defaultProvider = $provider | .defaultModel = $model | .defaultThinkingLevel = $thinking
          | .modelThinkingLevels[$provider + "/" + $model] = $thinking' \
        --join-output "$settings" > "$tmp"; then
        if ${pkgs.diffutils}/bin/cmp -s "$tmp" "$settings"; then
          rm -f "$tmp"
        else
          chmod 644 "$tmp"
          mv -f "$tmp" "$settings"
        fi
      else
        rm -f "$tmp"
        echo "omo: could not reset the startup model in $settings" >&2
      fi
    fi
    ${launch}
  '';
in
{
  imports = [
    (import ./settings.nix { inherit startupModel; })
    (import ./config.nix { inherit version; })
    ./codemode.nix
    ./memwatch.nix
    ./models.nix
  ];

  home.packages = [ omo ];

  # `/unsupervised <task>` (adapted from fersilva16's config). OmO arms
  # ultrawork only from typed `ulw` text, never from an expanded template, so
  # the template loads the skill itself. destructive-guard keys off the typed
  # command to refuse instead of ask for the rest of the run.
  home.file.".omo/agent/prompts/unsupervised.md".source = ./prompts/unsupervised.md;
}

# OmO Native: the standalone `omo` command (a pinned senpi/Pi-fork engine with
# the oh-my-openagent extension built in), kept apart from the Pi feature.
{
  lib,
  pkgs,
  agentPath,
  ...
}:
let
  version = "5.1.33";

  # Every new session starts here: settings.nix seeds it, the launcher restores it.
  startupModel = {
    provider = "anthropic-subscription";
    model = "claude-opus-5-5";
    thinking = "high";
  };

  # Release asset and hash per platform; bump every hash with `version`.
  releases = {
    aarch64-darwin = {
      asset = "omo-darwin-arm64";
      hash = "sha256-I5BM5XHNsZXoQIG6zES3dwNDAcV5UDlyzlZ6+yHwMBE=";
    };
    # A generic glibc build: it runs on NixOS through nix-ld (mellon's
    # agents.nix). Patching its interpreter would risk the appended payload.
    x86_64-linux = {
      asset = "omo-linux-x64";
      hash = "sha256-iTf8kZ1Mullz1xtZDE2zmfJh3e7Y2r6fPrYi3GLOIiA=";
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
  # The per-model thinking memory lives in state.json (OmO 5.1.x moved it out of
  # settings.json and strips it from there) and outranks defaultThinkingLevel, so
  # an Opus switch to xhigh (orchestrator leader) started every session at xhigh.
  # Every running session hot-reloads when settings.json changes, and OmO only
  # ignores edits that change routine keys, so a byte-only rewrite (jq's trailing
  # newline) reloaded them all. The file is rewritten only when the bytes differ,
  # serialized like OmO's own writes (no trailing newline).
  # codemode's process-isolated eval kernel (codemode.nix) spawns `bun` from
  # PATH; without it eval only worked when started inside a direnv dev shell.
  # Claude Code writes the subscription cache with a 1h TTL (2x input price),
  # but session logs showed reads after 5+ idle minutes missing ~85% of the
  # time anyway; 5m writes cost 1.25x. Experiment: export =1h to compare.
  omo = pkgs.writeShellScriptBin "omo" ''
    ${agentPath.prependPath}
    export PATH="${pkgs.bun}/bin:$PATH"
    export CLAUDE_CODE_PROMPT_CACHE_TTL="''${CLAUDE_CODE_PROMPT_CACHE_TTL:-5m}"
    export OMO_CODING_AGENT_DIR="''${OMO_CODING_AGENT_DIR:-$HOME/.omo/agent}"
    reset() {
      file="$1"; shift
      [ -f "$file" ] && [ ! -L "$file" ] || return 0
      tmp="$(mktemp "$file.XXXXXX")"
      if ${lib.getExe pkgs.jq} \
        --arg provider ${lib.escapeShellArg startupModel.provider} \
        --arg model ${lib.escapeShellArg startupModel.model} \
        --arg thinking ${lib.escapeShellArg startupModel.thinking} \
        "$@" --join-output "$file" > "$tmp"; then
        if ${pkgs.diffutils}/bin/cmp -s "$tmp" "$file"; then
          rm -f "$tmp"
        else
          chmod 644 "$tmp"
          mv -f "$tmp" "$file"
        fi
      else
        rm -f "$tmp"
        echo "omo: could not reset the startup model in $file" >&2
      fi
    }
    reset "$OMO_CODING_AGENT_DIR/settings.json" \
      '.defaultProvider = $provider | .defaultModel = $model | .defaultThinkingLevel = $thinking'
    reset "$OMO_CODING_AGENT_DIR/state.json" \
      '.modelThinkingLevels[$provider + "/" + $model] = $thinking
        | .modelLastOnThinkingLevels[$provider + "/" + $model] = $thinking'
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

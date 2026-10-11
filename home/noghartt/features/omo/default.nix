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

  # The release binary is bun-compiled and self-contained; it unpacks its
  # runtime into ~/.omo/binary-runtime/<version>/ on first run. `omo update`
  # only prints a curl line for binary installs, so bumping `version` here is
  # the update path.
  omo-unwrapped = pkgs.stdenvNoCC.mkDerivation {
    pname = "omo";
    inherit version;
    src = pkgs.fetchurl {
      url = "https://github.com/code-yeongyu/oh-my-openagent/releases/download/v${version}/omo-darwin-arm64";
      hash = "sha256-2s5s1cgQZ0Tw9cOrajVslCcqaGFcMV7fjL2Io+5EECw=";
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
      platforms = [ "aarch64-darwin" ];
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
    exec -a omo ${omo-unwrapped}/bin/omo "$@"
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
}

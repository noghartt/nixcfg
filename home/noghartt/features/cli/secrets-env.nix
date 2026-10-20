# Secrets as environment variables. Declare op:// references in envVars;
# they are resolved into the interactive shell env by `opnix env` and
# cached per user (see initContent). This is the pattern for tools that take secrets inline
# (API keys, tokens) instead of reading them from a file.
#
# Never read secret VALUES at eval time (builtins.readFile and friends):
# they would be baked into the world-readable nix store. Paths are fine,
# values are not.
{
  config,
  flake,
  pkgs,
  ...
}:
let
  opnix = "${flake.inputs.opnix.packages.${pkgs.stdenv.hostPlatform.system}.default}/bin/opnix";

  envVars = [
    {
      name = "TELEPATIA_LITELLM_API_KEY";
      # The key is stored in the item's notes field.
      reference = "op://Nix/TELEPATIA_LITELLM_API_KEY/notesPlain";
    }
    {
      # Jev (TypeSafe) decisions for the Pi/OmO orchestrator extension.
      name = "TYPESAFE_API_KEY";
      reference = "op://Nix/TYPESAFE_API_KEY/notesPlain";
    }
  ];

  configJson = builtins.toJSON { vars = envVars; };
  # Part of the cache file name, so editing envVars re-resolves at once.
  configHash = builtins.substring 0 12 (builtins.hashString "sha256" configJson);
  # Rotated values reach new shells after this; `rm -r` the cache dir to force it.
  cacheTtl = 4 * 60 * 60;
in
{
  home.sessionVariables = {
    OPNIX_ENV_TOKEN_FILE = "${config.home.homeDirectory}/.config/opnix/token";
  };

  programs.zsh.initContent = ''
    # Resolve 1Password secrets into env vars; skips cleanly without a token.
    # One `opnix env` call costs ~4s of service-account API time, too slow for
    # every new shell, so the output is cached in a private per-user runtime
    # dir (never the store or $HOME). Only the first shell waits; once stale,
    # a shell serves the cached values and refreshes in the background, and a
    # failed refresh keeps them until the next TTL.
    if [ -r "$OPNIX_ENV_TOKEN_FILE" ] && [ ${toString (builtins.length envVars)} -gt 0 ]; then
      () {
        zmodload -F zsh/stat b:zstat
        zmodload -F zsh/datetime p:EPOCHSECONDS
        local dir="''${XDG_RUNTIME_DIR:-''${TMPDIR:-/tmp}}/opnix-env-$UID"
        local cache="$dir/${configHash}.sh"
        local -a mtime resolve=(${opnix} env -token-file "$OPNIX_ENV_TOKEN_FILE" -config-json '${configJson}')
        if ! { mkdir -p -m 700 "$dir" 2>/dev/null && [[ -O $dir && ! -L $dir ]] }; then
          eval "$("''${resolve[@]}")"
          return
        fi
        if [[ ! -s $cache ]]; then
          ( umask 077; "''${resolve[@]}" >| "$cache.$$" && [[ -s $cache.$$ ]] && mv -f "$cache.$$" "$cache"; rm -f "$cache.$$" )
        elif zstat -A mtime +mtime "$cache" && (( EPOCHSECONDS - mtime[1] > ${toString cacheTtl} )); then
          # Touched first so shells opened meanwhile don't each start a refresh.
          touch "$cache"
          ( umask 077; "''${resolve[@]}" >| "$cache.$$" 2>/dev/null && [[ -s $cache.$$ ]] && mv -f "$cache.$$" "$cache"; rm -f "$cache.$$" ) &!
        fi
        [[ -s $cache ]] && source "$cache"
      }
    fi
  '';
}

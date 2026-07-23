# Secrets as environment variables. Declare op:// references in envVars;
# they are resolved into the interactive shell env by `opnix env` at
# startup. This is the pattern for tools that take secrets inline
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
    # { name = "GITHUB_TOKEN"; reference = "op://Personal/github/token"; }
  ];
in
{
  home.sessionVariables = {
    OPNIX_ENV_TOKEN_FILE = "${config.home.homeDirectory}/.config/opnix/token";
  };

  programs.zsh.initContent = ''
    # Resolve 1Password secrets into env vars; skips cleanly without a token.
    if [ -r "$OPNIX_ENV_TOKEN_FILE" ] && [ ${toString (builtins.length envVars)} -gt 0 ]; then
      eval "$(${opnix} env -token-file "$OPNIX_ENV_TOKEN_FILE" -config-json '${
        builtins.toJSON { vars = envVars; }
      }')"
    fi
  '';
}

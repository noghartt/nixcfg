# Resolves the sandbox env catalog's 1Password references with opnix (system
# token in /etc/opnix-token, set with `sudo opnix token set`). Without a token
# opnix skips cleanly and agentbox exec reports the variable as unresolved.
{ flake, lib, ... }:
let
  references = lib.filterAttrs (_: entry: entry ? reference) (import ./env-catalog.nix);
  # opnix wants camelCase keys: GH_TOKEN -> agentboxEnvGhToken.
  key =
    name:
    "agentboxEnv"
    + lib.concatMapStrings (
      part: lib.toUpper (builtins.substring 0 1 part) + lib.toLower (builtins.substring 1 (-1) part)
    ) (lib.splitString "_" name);
in
{
  imports = [ flake.inputs.opnix.nixosModules.default ];

  services.onepassword-secrets = lib.mkIf (references != { }) {
    enable = true;
    secrets = lib.mapAttrs' (
      name: entry:
      lib.nameValuePair (key name) {
        inherit (entry) reference;
        path = "/var/lib/opnix/secrets/agentbox-env/${name}";
      }
    ) references;
  };
}

# Net profiles as the kernel sees them, shared by agentbox-root (which puts
# each sandbox's /28 in its profile's source set), the firewall (which matches
# the sets) and the sandbox resolver (which fills the destination sets).
{ lib }:
let
  declared = import ./net-profiles.nix;
in
rec {
  inherit (declared) default;
  profiles = lib.mapAttrs (_: profile: {
    any = profile.any or false;
    domains = profile.domains or [ ];
  }) declared.profiles;

  names = lib.attrNames profiles;
  # Any public IPv4.
  open = lib.attrNames (lib.filterAttrs (_: p: p.any) profiles);
  # Only the addresses their domains resolve to.
  allowlisted = lib.attrNames (lib.filterAttrs (_: p: !p.any && p.domains != [ ]) profiles);
  # Every profile that gets the sandbox resolver at all.
  egress = open ++ allowlisted;

  src = name: "agentbox-src-${name}";
  dst = name: "agentbox-dst-${name}";

  # Idempotent; types must match wherever a set is created.
  create =
    lib.concatMapStrings (name: ''
      ipset create -exist ${src name} hash:net family inet
    '') names
    + lib.concatMapStrings (name: ''
      ipset create -exist ${dst name} hash:ip family inet
    '') allowlisted;

  # ipset names are at most 31 characters; agentbox-root also relies on them
  # being plain words.
  valid = lib.all (name: builtins.match "[a-z][a-z0-9]{0,15}" name != null) names;
}

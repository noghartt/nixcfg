# Environment variables a sandbox may opt into (`agentbox env NAME KEY...`, or
# cloud mode's `--env KEY,...`). A `reference` is resolved by opnix at boot
# into a root-only file that `agentbox exec` reads; a `value` is a non-secret
# literal and lands in the Nix store. Sandboxes reach the internet and run
# unattended, so anything given to one can leave it: keep secrets narrowly
# scoped (read-only tokens, scoped keys).
{
  # Fine-grained, read-only (contents, metadata, issues, pull requests) for gh's
  # API reads. Git never uses HTTPS, so it does not carry clones or fetches;
  # pushes and PRs go through cloud mode's publish tool.
  GH_TOKEN.reference = "op://Nix/AGENTBOX_GH_TOKEN/notesPlain";
  # Jev (TypeSafe) gating for an orchestrator or swarm leader run inside a sandbox.
  TYPESAFE_API_KEY.reference = "op://Nix/TYPESAFE_API_KEY/notesPlain";
}

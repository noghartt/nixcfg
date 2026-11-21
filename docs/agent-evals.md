# Agent evals (aeval)

The `agent-evals` feature (both hosts, imported by `home.nix`) is `aeval`, a Bun/TypeScript CLI
on `bun:sqlite` whose database, exports and replays live under
`${XDG_STATE_HOME:-~/.local/state}/agent-evals/` (0700). `aeval ingest` (hourly: systemd user
timer on Mellon, launchd agent on Palantir) imports OmO and Pi sessions (v3 trees, active branch
only), Claude Code projects (Agent SDK mirrors, `entrypoint: sdk-*`, are skipped: OmO's
claude-sdk provider writes one per OmO session) and Codex rollouts, re-reading only changed
files, plus the orchestrator outcome log from its last complete line. Secrets are redacted on
ingest and again on export. It derives tool error rate, retries, user corrections,
interruptions and active time per session. `aeval label` is a keyboard TUI (works over SSH) for
rating sessions, assistant turns, orchestrator nodes and replays, setting task classes, notes,
and preferred alternatives (`$EDITOR`). `aeval classify` adds heuristic class suggestions and,
with `--llm`, a print-mode pass on the cheapest pool tier. `aeval report` aggregates per model,
pool key and class. `aeval export` writes OpenAI or Anthropic
SFT/preference JSONL from labelled turns only, with a manifest. `aeval replay` re-runs a node's
or session's task on candidate models in remote-less scratch clones (or agentbox sandboxes via
OmO cloud mode) and stores diffs and final answers for side-by-side rating; it never touches the
real checkout and cannot push. Pool keys come from the orchestrator's `config.json`; the
package's test suite runs in its build.

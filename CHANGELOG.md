# Changelog

## 0.1.0 — 2026-07-06

Initial public release, extracted from its incubation repository after
multiple live two-model runs.

- Author/reviewer loop between Claude Code and Codex with a code-enforced
  approval gate: orchestrator-assigned finding IDs, recomputed verdicts, and
  a strict blocker/major convergence rule (two failed re-reviews per finding
  → human handoff; never auto-approves).
- Crash-safe artifact graph: atomic commits, idempotent projections,
  suspension-aware timeouts, append-only failure records with human
  clearance, and artifact-precise `resume` that never re-bills completed
  calls.
- Read-only providers (`--safe-mode` + Read/Glob/Grep for Claude, read-only
  sandbox for Codex), per-role reasoning efforts (defaults claude=xhigh,
  codex=high), per-role timeouts, structured output validated with Ajv.
- Requirements by file, stdin, or inline text; approved plans auto-archived
  to `docs/plans/<task-id>.md` with the frozen requirement appended.
- `doctor` environment preflight; human `override` with append-only audit.
- Ships as a Claude Code plugin/marketplace, an npm CLI, a skills-directory
  clone, and a Codex custom prompt.

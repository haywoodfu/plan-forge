# Changelog

## 0.1.3 — 2026-07-15

- Resolve provider models explicitly: `--author-model` / `--reviewer-model`,
  then `PLAN_FORGE_CLAUDE_MODEL` / `PLAN_FORGE_CODEX_MODEL`, then the provider
  CLI's own default. No default model is baked in — availability depends on the
  account behind the CLI, so naming one would fail for everyone who lacks it.
- Fixes a silent quality bug. The codex adapter passes `--ignore-user-config`
  so a review cannot depend on machine-local settings; that also means a
  `model = "..."` in `~/.codex/config.toml` was never honoured. Codex fell back
  to its small built-in default and the audit trail recorded `"model": null`,
  which is indistinguishable from "the default was fine". A weak reviewer that
  finds nothing reads exactly like a strict reviewer with nothing to find, so
  this surfaced as good-looking plans rather than as a misconfiguration.
- Rewrite the reviewer prompt, which described the output contract and nothing
  about how to review. It now requires verifying the plan's claims against the
  repository rather than inheriting them, treats approval as a conclusion that
  must show its work (a zero-finding review states which claims it checked),
  names where defects concentrate, and calibrates severity against consequence.
  A frontier reviewer did much of this unprompted; a smaller one did not, which
  is exactly why it belongs in the prompt rather than in a model's disposition.
- Document model selection in the README, and correct its claim that the
  reviewing model "consistently catches" gaps — blind spots are per-model. Two
  reviews of one frozen requirement, roles swapped, overlapped almost not at
  all: each caught a real defect the other missed entirely.

## 0.1.2 — 2026-07-07

- Accept a Linear issue key or URL as the requirement input: the
  orchestrating agent fetches the ticket (title, description, comments)
  via an available Linear tool and treats it as the raw requirement.
- The mandatory clarify → structure → confirm → freeze flow still applies
  in full; ticket provenance is recorded as a `Source:` line inside the
  structured requirement, so the CLI and schemas are unchanged.
- Mirrored in the Codex custom prompt, with a fallback that asks the user
  to paste ticket content when no Linear tool is available.

## 0.1.1 — 2026-07-06

- Add Codex plugin metadata and repo marketplace distribution.
- Promote npm and Codex plugin install paths in the README.
- Keep the legacy Codex custom prompt as a fallback with explicit
  `/prompts:plan-forge` invocation.

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

---
description: Run plan-forge adversarial implementation-plan review between Claude Code and Codex
argument-hint: REQUIREMENT
---

# plan-forge — adversarial plan review

You are orchestrating the `plan-forge` CLI (https://github.com/haywoodfu/plan-forge):
an author/reviewer loop between Claude Code and Codex. You operate the CLI;
you never author or review the plan yourself.

The text after `/prompts:plan-forge` is the user's raw requirement: $ARGUMENTS

Follow these steps strictly:

1. Run `plan-forge doctor` (or `node <plan-forge>/cli.mjs doctor`) once per
   machine; all checks must pass before anything else.
2. If $ARGUMENTS is (or contains) a Linear issue key (uppercase letters +
   digits, e.g. `ENG-123`) or a `linear.app` issue URL, fetch the issue
   first with a Linear tool configured in your environment (MCP `get_issue`;
   pull comments too when the description is thin) and treat its title +
   description as the raw requirement — never freeze ticket content as-is.
   Open the structured requirement with a source line
   (`Source: ENG-123 — <issue url>`) and derive the task id from the ticket
   key (e.g. `eng-123-<short-slug>`). If no Linear tool is available, say so
   and ask the user to paste the ticket content — never guess or skip.
3. **Never freeze a raw one-liner.** Ask the user targeted clarifying
   questions (goal, constraints, acceptance criteria, non-goals, affected
   surfaces), then draft a structured requirement with headings
   Goal / Constraints / Acceptance criteria / Non-goals.
4. Show the draft to the user together with the cost estimate (a 3–4 round
   task at default efforts costs roughly $15–25 of Claude usage plus Codex
   usage, 30–60 minutes). Start only after the user explicitly confirms both.
5. Freeze and run, deriving a short kebab-case task id from the content:

   ```bash
   plan-forge run --task <task-id> --requirement-text "<structured text>" \
     --author claude --reviewer codex
   ```

6. Monitor `.plan-forge/<task-id>/run.log`; check with
   `plan-forge status --task <task-id>` (free). On `failed`, fix the
   environment and `plan-forge resume --task <task-id>`.
7. On `needs_human`, present the open findings and both sides' arguments to
   the user and let them decide; `override` and `--clear-failures` are human
   decisions — never apply them on your own judgment.
8. On approval, report the archived plan path: `docs/plans/<task-id>.md`.

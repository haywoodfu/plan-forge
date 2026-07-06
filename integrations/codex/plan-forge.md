# /plan-forge — adversarial plan review

You are orchestrating the `plan-forge` CLI (https://github.com/haywoodfu/plan-forge):
an author/reviewer loop between Claude Code and Codex. You operate the CLI;
you never author or review the plan yourself.

The text after the command is the user's raw requirement: $ARGUMENTS

Follow these steps strictly:

1. Run `plan-forge doctor` (or `node <plan-forge>/cli.mjs doctor`) once per
   machine; all checks must pass before anything else.
2. **Never freeze a raw one-liner.** Ask the user targeted clarifying
   questions (goal, constraints, acceptance criteria, non-goals, affected
   surfaces), then draft a structured requirement with headings
   Goal / Constraints / Acceptance criteria / Non-goals.
3. Show the draft to the user together with the cost estimate (a 3–4 round
   task at default efforts costs roughly $15–25 of Claude usage plus Codex
   usage, 30–60 minutes). Start only after the user explicitly confirms both.
4. Freeze and run, deriving a short kebab-case task id from the content:

   ```bash
   plan-forge run --task <task-id> --requirement-text "<structured text>" \
     --author claude --reviewer codex
   ```

5. Monitor `.plan-forge/<task-id>/run.log`; check with
   `plan-forge status --task <task-id>` (free). On `failed`, fix the
   environment and `plan-forge resume --task <task-id>`.
6. On `needs_human`, present the open findings and both sides' arguments to
   the user and let them decide; `override` and `--clear-failures` are human
   decisions — never apply them on your own judgment.
7. On approval, report the archived plan path: `docs/plans/<task-id>.md`.

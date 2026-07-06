---
name: plan-forge
description: Run an adversarial plan review loop between two AI coding agents (Claude Code and Codex CLI) — one drafts a complete implementation plan for a frozen requirement, the other reviews it, and unresolved blocker/major findings drive full-plan revisions until approval or an auditable human handoff. Use when the user asks for a "plan review", "adversarial review", "cross review", "互审", or wants two models to iterate on a plan before implementation.
---

# plan-forge — adversarial plan review

You are orchestrating `plan-forge`, a local CLI that runs an author/reviewer
loop between Claude Code and Codex. You operate the CLI; you never act as the
author or reviewer yourself, and the model subprocesses run read-only.

## Before starting a task (mandatory)

1. **Preflight once per machine.** Locate the plan-forge root — the
   directory containing `cli.mjs`: it is the directory of this SKILL.md for a
   skills-directory clone, or two levels up (the plugin root) when installed
   as a plugin. Run `node <plan-forge-root>/cli.mjs doctor` (or
   `plan-forge doctor` / `npx plan-forge doctor` if installed from npm). All
   checks must pass — it verifies both provider CLIs exist and support every
   flag the adapters need, without spending any tokens. If it reports `ajv`
   as not resolvable, run `npm install` in the plan-forge root once.
2. **Structure the requirement — this step is never optional.** When the
   user invokes `/plan-forge <raw requirement text>` (or gives you a vague
   ask), you MUST NOT freeze it as-is. The review loop gates plans against
   the frozen requirement; a one-liner gives the reviewer nothing to hold the
   author to. Instead:
   1. Ask the user targeted clarifying questions: goal, constraints,
      acceptance criteria, explicit non-goals, affected surfaces.
   2. Draft the structured requirement (headings: Goal / Constraints /
      Acceptance criteria / Non-goals) grounded in what you learned.
   3. Show the draft to the user **together with the cost estimate** (at
      default efforts a 3–4 round task costs **$15–25 on the Claude side**
      plus Codex usage and takes 30–60 minutes).
   4. Only after the user explicitly confirms both the text and the spend,
      freeze it.
3. **Freeze the requirement** using either channel — the task snapshots the
   text either way, and the approved plan archives it as an appendix:
   - inline: `plan-forge run --task <id> --requirement-text "<structured text>"`
     (or pipe long text: `plan-forge run --task <id> --requirement -`), or
   - file: write `docs/requirements/<task-id>.md` and pass `--requirement`.
   Derive the task id yourself: kebab-case, short, content-derived.
4. The target directory must be a git repository. Warn the user if
   `.plan-forge/` is not in the repo's `.gitignore` (the CLI also warns).

## Running

```bash
plan-forge run \
  --task <kebab-case-id> \
  --requirement docs/requirements/<task-id>.md \
  --author claude --reviewer codex
```

- Defaults: `max-rounds=6`, efforts claude=`xhigh` / codex=`high`, timeouts
  1200 s per role. Swap `--author`/`--reviewer` to reverse the pairing.
- Runs take tens of minutes: execute in the background and monitor
  `.plan-forge/<task-id>/run.log` (stage lines, provider heartbeats every
  15 s, suspension notices). On laptops advise the user to keep the lid open;
  system sleep extends deadlines but stretches wall-clock time.
- Check progress with `plan-forge status --task <id>` (never costs tokens).

## Outcomes

- **approved** — the final plan is archived automatically to
  `docs/plans/<task-id>.md` (override with `--publish-dir`). Show the user
  that path and a summary of rounds/findings.
- **failed** — one provider call failed; environment is usually the cause.
  Fix it, then `plan-forge resume --task <id>`. Resume never re-runs
  committed rounds.
- **needs_human** — the loop stopped on purpose (max rounds, a critical
  finding unresolved for two consecutive re-reviews, or repeated provider
  failures). **Present the open findings and both sides' arguments to the
  user and let them decide.** Never apply `override` or `--clear-failures`
  on your own judgment; they are human decisions:
  - `plan-forge override --task <id> --finding F007 --disposition withdrawn --reason "<user's reason>"`
  - `plan-forge resume --task <id> --clear-failures --reason "<why the environment is fixed>"`

## Recovery cheat-sheet

| Symptom | Action |
|---|---|
| Provider timed out | `resume --task <id>` (optionally `--reviewer-timeout 1800`) |
| Stuck `needs_human` after provider failures | fix environment → `resume --clear-failures --reason "..."` |
| Stale lock after a crash | `resume --task <id>` reclaims dead-PID locks; `--force-unlock` only with user consent |
| Requirement must change | new task id — frozen requirements are immutable |

Never hand-edit files under `.plan-forge/`; every artifact is hash-checked.

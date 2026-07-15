# Concurrent reviewers

## Goal

Let multiple reviewers review the same plan **concurrently and independently**
within one round, merge their findings, and drive a **single** author revision
from the merged set. The purpose is to widen defect coverage.

## Background (evidence, not speculation)

Two runs against one frozen requirement produced reviewer findings whose
**intersection was near zero**:

- Claude found: the gated projection was subtractive (`..config`), the line
  wiring enforcement to redaction had no automated coverage, and the edge-cache
  invariant protecting a newly session-varying response was undocumented.
- gpt-5.6-sol independently found the first two, **missed** the cache one, but
  found one Claude missed: the plan removed `CompareLinesSection` entirely
  instead of synthesizing the blurred placeholder the requirement demanded.
- gpt-5-mini (this tool's effective default until now, because the codex adapter
  passes `--ignore-user-config` and no model was specified) returned **zero
  findings and approved** the same plan in one round.

Single-reviewer variance is large enough to decide between "no defects" and "two
majors" on an identical plan. That is the problem this change addresses.

## Constraints

- **The audit chain must not break.** Every review stays independently
  traceable (provider, model, prompt hash, `planSha256`). `approval.json` and
  the round `manifest.json` must be able to express multiple reviews per round.
- **Backward compatibility.** Existing single-reviewer tasks
  (`task.reviewer: 'codex'`) must resume, and single-reviewer behavior must be
  byte-for-byte unchanged.
- **Four structural conflicts must be resolved.** The current code assumes one
  review per round:
  1. `lib/findings.mjs` `normalizeReviewerOutput` calls
     `nextFindingNumber(before)` — concurrent reviewers allocate the *same*
     `F00N`, and `applyReviewToMap` then throws `duplicate finding id`.
  2. The verdict self-check at the end of the same function requires
     `verdict === (blockingFindings(after).length ? 'changes_requested' :
     'approved')`. A concurrent reviewer cannot see its peer's findings, so its
     verdict necessarily disagrees with the merged outcome.
  3. The same function's opening check forces every reviewer to disposition
     *every* active finding (`missing`/`extra` mismatch throws). With two
     reviewers there is no rule for conflicting dispositions.
  4. `lib/workflow.mjs` `loadRoundArtifacts` reads a single `files.review`, and
     `reviews.some((item) => item.meta.round === currentRound)` decides whether
     a round has been reviewed.
- **Reviewer independence**: concurrent reviewers must not see each other's
  findings.
- Read-only: do not implement, do not commit.

## Acceptance criteria

1. N reviewers (N≥1) review the same plan concurrently; N=1 behaves exactly as
   today.
2. Finding ID allocation is race-free and deterministically ordered.
3. Conflicting dispositions have a **defined and justified** arbitration rule.
4. The verdict composition rule across reviewers is explicit.
5. Every finding is traceable to the reviewer that raised it.
6. Partial failure resumes: if reviewer A succeeded and B failed, resume re-runs
   only B.
7. The existing 31 tests do not regress; new tests cover the merge semantics and
   the conflict arbitration.

## Open design questions

The plan must choose **and argue for** an answer to each. The reviewer should
attack the quality of the argument, not merely check that an answer exists.

- **Q1** — Which disposition wins a conflict? "Any `still_open` keeps it open"
  is the conservative default, but would one weak reviewer then stall every
  round indefinitely? Is there a better rule?
- **Q2** — Do duplicate findings across reviewers need merging? Observed
  intersection is small, but "the same defect found independently by both" did
  occur. What does *not* merging cost?
- **Q3** — Should a reviewer be told it is one of several independent reviewers?
  Does telling it induce diffusion of responsibility ("the other one will catch
  it"), or change its strictness?

## Non-goals

- Concurrent authors mutating one plan (breaks single-plan lineage and the
  resume cache).
- LLM-based automatic deduplication (unless Q2's argument concludes otherwise).
- Changing the severity ladder or the blocker/major blocking semantics.
- Changing provider adapters or model resolution.
- Reviewer-to-reviewer debate or consensus protocols — this change is fan-out
  plus merge only.

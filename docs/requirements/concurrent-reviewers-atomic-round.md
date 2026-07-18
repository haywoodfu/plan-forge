# Concurrent reviewers (atomic round)

## Goal

Let multiple reviewers review the same plan **concurrently and independently**
within one round, merge their findings, and drive a **single** author revision
from the merged set. The purpose is to widen defect coverage.

A round is **atomic**: either every reviewer in it succeeds and the round
commits as a whole, or the round commits nothing and is re-run in full. There is
no partial-success state, and therefore no successful reviewer's output is ever
persisted while a peer in the same round is still pending or being re-run.

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

**Why atomic rounds (supersedes the earlier partial-recovery design).** An
earlier framing of this requirement asked resume to re-run only the failed
reviewer while preserving the successful ones. Adversarial plan review found that
this cannot coexist with reviewer independence under the current architecture:
preserving a successful peer means persisting its output, and reviewers hold
repository-wide read access (the codex adapter runs a read-only, not
read-isolated, sandbox; the claude adapter grants unrestricted Read/Glob/Grep),
so a re-run reviewer can read its peer's review — and even with review files
hidden, a normalization failure persists a reviewer's raw output under the
readable `failures/` directory. The author and reviewer agreed the two goals were
irreconcilable without changing the provider adapters, which is a non-goal. The
human ruling was to drop partial recovery: independence is the reason this
feature exists, so it is kept as a hard constraint and recovery efficiency is
sacrificed instead.

## Constraints

- **The audit chain must not break.** Every review stays independently
  traceable (provider, model, prompt hash, `planSha256`). `approval.json` and
  the round `manifest.json` must be able to express multiple reviews per round.
- **Backward compatibility.** Existing single-reviewer tasks
  (`task.reviewer: 'codex'`) must resume, and single-reviewer behavior must be
  byte-for-byte unchanged.
- **Reviewer independence is enforceable, not merely requested.** Within a round
  no reviewer's findings — or raw output, or any artifact derived from them — are
  observable by another reviewer of the same round, on the first pass or on any
  re-run. Atomic rounds make this achievable: because nothing partial is
  persisted, there is no same-round peer artifact for a re-run reviewer to read.
- **Three structural conflicts must be resolved.** The current code assumes one
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
- **Atomic round commit.** `lib/workflow.mjs` `loadRoundArtifacts` reads a single
  `files.review`, and `reviews.some((item) => item.meta.round === currentRound)`
  decides whether a round has been reviewed. A round with N reviewers must commit
  all N reviews together or none, and a crash mid-round must leave the round
  re-runnable from clean, with no half-written peer output readable on the re-run.
- Read-only: do not implement, do not commit.

## Acceptance criteria

1. N reviewers (N≥1) review the same plan concurrently; N=1 behaves exactly as
   today.
2. Finding ID allocation is race-free and deterministically ordered.
3. Conflicting dispositions have a **defined and justified** arbitration rule.
4. The verdict composition rule across reviewers is explicit.
5. Every finding is traceable to the reviewer that raised it.
6. **A round is all-or-nothing.** If any reviewer in a round fails, the whole
   round is discarded and re-run; no reviewer output from a failed round
   survives to be read on the re-run. A resume after a mid-round crash re-runs
   the entire round, never a subset of its reviewers.
7. The existing tests do not regress; new tests cover the merge semantics, the
   conflict arbitration, and the all-or-nothing round boundary — including that
   a failed round leaves no peer artifact (review **or** raw failure output)
   readable by the re-run.

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
- **Q4** — Re-running a whole round on any single failure re-bills the reviewers
  that already succeeded. What bounds the worst case (a persistently flaky slot
  re-running the round until `max-rounds`), and where is that bound enforced?

## Non-goals

- **Partial-round recovery.** Re-running only the failed reviewer while
  preserving successful peers is explicitly out of scope — it is the design this
  requirement supersedes, for the independence reason in Background.
- Concurrent authors mutating one plan (breaks single-plan lineage and the
  resume cache).
- LLM-based automatic deduplication (unless Q2's argument concludes otherwise).
- Changing the severity ladder or the blocker/major blocking semantics.
- Changing provider adapters or model resolution.
- Reviewer-to-reviewer debate or consensus protocols — this change is fan-out
  plus merge only.

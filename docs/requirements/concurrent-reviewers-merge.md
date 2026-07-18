# Concurrent reviewers (merge, non-isolated)

## Goal

Let a task run N reviewers (N ≥ 1) against the same plan in one round,
concurrently. After every reviewer in the round has returned, merge their
findings into one set and drive a single author revision from that merged set.
Widening defect coverage is the entire point: the union of N independent reviews
is strictly more informative than any one.

Reviewers are independent at the prompt level — no reviewer's findings are placed
in another reviewer's prompt, so each forms its own view of the same plan.
Reviewers are NOT required to be isolated at the process or OS level.

## Background (evidence, not speculation)

Two runs against one frozen requirement produced reviewer findings whose
**intersection was near zero**:

- Claude found: the gated projection was subtractive (`..config`), the line
  wiring enforcement to redaction had no automated coverage, and the edge-cache
  invariant protecting a newly session-varying response was undocumented.
- gpt-5.6-sol independently found the first two, **missed** the cache one, but
  found one Claude missed: the plan removed `CompareLinesSection` entirely
  instead of synthesizing the blurred placeholder the requirement demanded.
- gpt-5-mini (this tool's effective default until recently, because the codex
  adapter passes `--ignore-user-config` and no model was specified) returned
  **zero findings and approved** the same plan in one round.

Single-reviewer variance is large enough to decide between "no defects" and "two
majors" on an identical plan. That is the problem this change addresses. Note
the one observed overlap: two reviewers independently raised the same two
defects, which is the duplicate case Q2 must answer for.

Why prompt-level independence, not enforced isolation (supersedes two earlier
framings): adversarial review of v2 and atomic-round found enforced isolation
unachievable without changing provider adapters (a non-goal) — same-UID child
processes with repo read access leak via output file, process argv, /proc/<pid>/fd,
or ptrace. The human ruling: independence exists to widen coverage, delivered by
not feeding a reviewer its peers' findings in the prompt. Enforced OS isolation is
dropped; same-UID readability is an accepted, documented boundary. This also makes
partial-failure recovery viable again.

## Constraints
- Audit chain intact; every merged finding names the reviewer that raised it.
- Backward compatible; single-reviewer **behavior** unchanged: same plan, same
  findings, same verdict, same published artifacts, and existing tasks resume.
  This is a behavioral contract, not a byte-level one — shared prompt, schema,
  and artifact-field changes that N=1 and N>1 both go through are allowed and
  are preferred over forking a parallel N=1 code path. Additive fields and
  reworded prompts are fine if what N=1 produces and a consumer reads is
  equivalent.
- Prompt-level independence, best-effort; same-UID readability is NOT a blocker.
- Barrier merge: wait until every reviewer returns, then merge the union.
- Single author revision per round; author never invoked once per reviewer.
- Duplicates cost the author no repeated work: one resolution may cover multiple
  semantically equivalent findings; all originals preserved and traceable.
- Three structural conflicts (ID allocation, verdict self-check, disposition
  completeness) + loadRoundArtifacts must read N reviews per round.
- **Committed rounds are frozen.** A round was reviewed under the overrides in
  force at that moment; that is its permanent, correct context. A later override
  never invalidates, re-validates, or rewrites a committed round's artifacts, and
  loading history must not compare a historical round against the current
  override document. Override freshness is a question only for the in-flight
  round being resumed or re-run.
- Read-only.

## Acceptance criteria
1. N reviewers concurrent; N=1 behaviorally as today (see the backward-compat
   constraint: equivalent output, not identical bytes).
2. Finding ID allocation race-free, deterministic.
3. Conflicting dispositions have a defined+justified arbitration rule.
4. Verdict composed from the merged set, not any single reviewer's verdict.
5. Every finding traceable to its reviewer.
6. Barrier: author runs once per round, only after all reviewers merged.
7. One author resolution may dispose of multiple equivalent findings consistently.
8. Partial-failure recovery: resume re-runs only the failed reviewer.
   A committed round survives a later override untouched.
9. Existing tests don't regress; new tests cover merge, arbitration, dup-coverage.

## Open design questions
Q1 conflict disposition winner; Q2 where dup handling happens (author-level vs
merge-time detection — argue trade-off, don't assume an LLM dedup); Q3 tell a
reviewer it's one of several?; Q4 partial recovery re-run reads committed peers
(now allowed) — anchoring cost vs recompute saved, and barrier reconciliation.

## Non-goals
Concurrent authors; changing provider adapters/model resolution; changing the
severity ladder; LLM auto-dedup unless Q2 concludes otherwise; reviewer debate.
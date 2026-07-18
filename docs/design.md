# plan-forge — Design: an Adversarial Plan Review Workflow

> This is the project's design document, carried over from the repository the
> tool was incubated in. Implementation files live at the repo root
> (`cli.mjs`, `lib/`, `prompts/`, `schemas/`, `test/`). Sections about
> `.gitignore` / agent-instruction files describe how a **consumer**
> repository integrates the tool.

## Status

- Status: implemented and validated with live two-model runs
- Revision: rev5 — incorporates two review rounds of major/minor findings
  (failure clearance, quote-safe argument passthrough, manifest backfill,
  precise status reporting, tolerance for extra resolutions)
- Goal: for a frozen requirement, model A drafts a complete plan and model B
  reviews it; as long as any `blocker` or `major` finding remains open, A must
  answer every finding and produce a complete new plan for B to re-review —
  until approval or an explicit human handoff.
- v1 scope: local CLI workflow, file-based audit, crash recovery, two
  providers (Claude Code and Codex).

## Quick usage

### 1. Preflight (`plan-forge doctor`)

The workflow drives the real Claude Code and Codex CLIs. Before starting,
confirm both are installed and authenticated:

```bash
plan-forge doctor   # checks CLI presence, versions, and every required flag — zero tokens
```

### 2. Write a frozen requirement

Save the requirement as Markdown, e.g. `docs/requirements/login-rate-limit.md`:

```md
# Login rate limiting

Add per-IP rate limiting to the login endpoint:

- at most 10 attempts per IP per minute
- return HTTP 429 over the limit
- include unit tests
- do not affect already-authenticated endpoints
```

The requirement file is copied into the task's artifacts at creation time;
editing the original file later does not affect a running task. A `task-id`
may contain lowercase letters, digits, dots, underscores, and hyphens, and
must start with a letter or digit.

### 3. Start the loop

Claude drafts, Codex reviews:

```bash
plan-forge run \
  --task login-rate-limit \
  --requirement docs/requirements/login-rate-limit.md \
  --author claude \
  --reviewer codex
```

Swap the roles:

```bash
plan-forge run \
  --task login-rate-limit-codex \
  --requirement docs/requirements/login-rate-limit.md \
  --author codex \
  --reviewer claude
```

When Claude is the Author you may append `--claude-author-max-budget-usd 2`;
when Claude is the Reviewer, use `--claude-reviewer-max-budget-usd 1`.

Runtime artifacts live under `.plan-forge/<task-id>/`, which should be
gitignored (the CLI warns if it is not).

While running, phase transitions, provider attempts, retries, and artifact
commits stream to the terminal's stderr. If a provider produces no output, a
heartbeat is logged every 15 seconds; the provider's own stderr is forwarded
live with a `claude:stderr` / `codex:stderr` prefix. The same lines are
appended to:

```text
.plan-forge/<task-id>/run.log
```

Follow along from another terminal:

```bash
tail -f .plan-forge/login-rate-limit/run.log
```

These logs never contain prompts, environment variables, or credentials.
stdout is reserved for the final status JSON or the final plan, so scripts
can consume it.

### 4. Status and recovery

```bash
plan-forge status --task login-rate-limit
```

Status meanings:

- `approved` — the loop converged; the final plan exists.
- `failed` — the current call failed but all artifacts are intact; resumable.
- `needs_human` — round limit reached, a critical finding survived two
  consecutive re-reviews, or repeated provider failures.
- `running` — not at a terminal state; can continue.

Resume an existing task:

```bash
plan-forge resume --task login-rate-limit
```

Never `run` the same task id twice; existing tasks must use `resume`.

### 5. View or publish the final plan

Print the approved plan:

```bash
plan-forge show --task login-rate-limit
```

Approved plans are archived automatically (see §2 below). To copy an extra
snapshot elsewhere:

```bash
plan-forge show \
  --task login-rate-limit \
  --publish docs/plans/extra-copy.md
```

### 6. Human rulings on findings

First inspect `.plan-forge/<task-id>/rounds/*/review.json` and the blocking
finding IDs reported by `status`.

Withdraw a finding:

```bash
plan-forge override \
  --task login-rate-limit \
  --finding F001 \
  --disposition withdrawn \
  --reason "out of scope for this requirement"
```

Downgrade (or upgrade) severity:

```bash
plan-forge override \
  --task login-rate-limit \
  --finding F001 \
  --disposition severity_changed \
  --severity minor \
  --reason "documentation-only impact; does not block implementation"
```

Then continue:

```bash
plan-forge resume --task login-rate-limit
```

Human overrides are appended to `overrides.json` and enter the final audit
record; they never rewrite review history.

## 1. Goal and boundaries

The workflow has one explicit entry point:

```bash
plan-forge run \
  --task <task-id> \
  --requirement <requirement-file> \
  --author claude \
  --reviewer codex
```

Defaults:

```text
author=claude
reviewer=codex
max-rounds=6
```

The full loop:

1. Freeze the requirement file and record its SHA-256.
2. Model A drafts a complete plan from the requirement and the repository.
3. Model B reviews the plan and its structured findings are committed to disk.
4. If any `blocker` or `major` remains open, model A must answer every open
   finding — at every severity, not only the blocking ones — and produce a
   complete new plan.
5. Model B re-reviews the new plan, dispositions every open finding, and is
   shown the findings it already closed so a defect that resurfaces can be
   filed as a recurrence rather than as a discovery.
6. When no `blocker`/`major` remains open, the workflow produces `final.md`
   and an approval record.
7. When an anti-livelock condition triggers, the workflow stops as
   `needs_human`; it never auto-approves.

v1 does not drive the loop through Claude Code or Codex hooks. Both models
are invoked by an external Node orchestrator, avoiding recursive triggering,
implicit side effects, and unrecoverable half-finished states.

## 2. Directory and file layout

Implementation files:

```text
├── cli.mjs
├── lib/
│   ├── artifacts.mjs
│   ├── doctor.mjs
│   ├── logger.mjs
│   ├── workflow.mjs
│   ├── merge.mjs
│   ├── roster.mjs
│   ├── process.mjs
│   ├── prompts.mjs
│   ├── schema.mjs
│   ├── findings.mjs
│   └── providers/
│       ├── codex.mjs
│       └── claude.mjs
├── prompts/
│   ├── shared-policy.md
│   ├── author.md
│   ├── revise.md
│   └── reviewer.md
├── schemas/
│   ├── author-output.schema.json
│   ├── reviewer-output.schema.json
│   └── merged-review.schema.json
└── test/
    ├── workflow.test.mjs
    ├── concurrent.test.mjs
    ├── artifacts.test.mjs
    ├── doctor.test.mjs
    ├── findings.test.mjs
    ├── merge.test.mjs
    ├── roster.test.mjs
    ├── logging.test.mjs
    ├── prompts.test.mjs
    ├── providers.test.mjs
    ├── schema.test.mjs
    └── live.test.mjs
```

Per-task runtime artifacts:

```text
.plan-forge/<task-id>/
├── task.json
├── requirement.md
├── state.json
├── run.log
├── failures/
│   └── 000001.json
├── rounds/
│   ├── 001/
│   │   ├── author-output.json
│   │   ├── plan.md
│   │   ├── resolution.json
│   │   ├── reviews/
│   │   │   ├── R1.json
│   │   │   └── R2.json
│   │   ├── review.json
│   │   └── manifest.json
│   └── 002/
├── overrides.json
├── approval.json
└── final.md
```

A task runs **N reviewer slots** (N ≥ 1), stored as `task.reviewers: [...]` in
`task.json` (legacy tasks keep the singular `reviewer*` keys and normalize to a
one-slot roster on load; the roster's shape is frozen at creation). Each slot's
raw capture commits to `rounds/NNN/reviews/<slot>.json`; after every slot has
committed at the round's current prompt fingerprint, the orchestrator merges
them into `rounds/NNN/review.json` — same path and shape as the single-reviewer
document, which is what keeps `collectFindings` and every legacy round working
unchanged.

**`meta.schemaVersion` is per file format and is never inferred.** A merged
`review.json` declares `2` and is validated whole-wrapper against
`schemas/merged-review.schema.json` (provenance — `meta.reviewers`, `raisedBy`,
`sourceIndex`, `arbitration` — is *required*); every pre-existing `review.json`
declares `1` and takes today's validation path, with a hard error if it carries
merge provenance. A missing or unknown version is a hard error, never a
fallback: absence-as-signal would make the weaker branch the default and let a
damaged merged round skip its own capture verification. Slot captures are the
first format of a new file and stay at `1`; `task.json`, `state.json`,
`approval.json`, `manifest.json`, and the overrides document are untouched at
`1`.

On load, a merged round's captures are verified against the round's own
manifest: `meta.reviewers` must equal the frozen roster's slot set, each
capture's bytes must hash to the recorded `captureSha256`, and a capture for an
unknown slot is an error. This is frozen-input-vs-frozen-input — no current
state (in particular, no override) can change the answer. A committed
`review.json` is an authoritative commit, never recomputed: re-deriving it on
load would run `collectFindings` under *current* overrides and silently rewrite
a frozen round's verdict.

The published archive is self-contained: the frozen requirement is appended
to `docs/plans/<task-id>.md` as an appendix, so inline-requirement tasks
(with no requirement file outside the gitignored runtime dir) remain fully
auditable from version control alone.

`.plan-forge/` belongs in the consumer repo's `.gitignore` (`run` warns when
it is not covered). Two plans are **published automatically** into version
control, and the header's `status=` field is the only thing that tells them
apart — never infer approval from the path:

- `docs/plans/<task-id>.md` (`status=approved`) — written by `finalize`, which
  throws before publishing if any blocking finding remains. Its existence is
  therefore a gate signal a consumer can trust without querying state.
- `docs/plans/needs_human/<task-id>.md` (`status=needs_human`) — written when
  the loop **deliberately** stops (round limit or a stalled critical finding).
  It carries no `approvedAt`, lists `blockingFindingIds`, and opens with a
  decision brief: why it stopped, and per blocking finding the problem,
  required change, evidence, and **both sides' positions** — the reviewer's
  latest explanation and the author's resolution. Without it the plan and the
  argument that stopped it stay in the gitignored runtime dir, which strands
  the decision on one machine and hides it from the person who has to make it.
  A provider-failure `needs_human` publishes nothing: the environment broke,
  and no design decision is owed.

`finalize` removes any stale `needs_human/<task-id>.md` when it publishes an
approved plan — two contradictory published plans are worse than none. Both
paths follow `--publish-dir`. `show --publish <path>` only makes additional
copies to custom paths.

## 3. State machine and recovery model

`state.json` example:

```json
{
  "schemaVersion": 1,
  "taskId": "anchor-context",
  "round": 2,
  "phase": "reviewing",
  "status": "running",
  "requirementSha256": "...",
  "blockingFindingIds": ["F001"],
  "errorClass": null,
  "updatedAt": "..."
}
```

`phase` enum:

```text
drafting | reviewing | revising | finalizing
```

`status` enum:

```text
running | failed | approved | needs_human
```

State flow:

```text
drafting → reviewing → revising → reviewing
    │          │          │           │
    └──────────┴──────────┴───────────┴→ failed (resumable)
                  └──────────────→ finalizing → approved
                  └──────────────→ needs_human
```

`failed` means the current artifact was not produced but every existing
artifact remains valid. The first non-transient provider failure or internal
error enters `failed`, keeping the current `phase`; `resume` retries the same
phase. Reaching `maxProviderFailures` consecutive failures in the same phase
(default 2) enters `needs_human`. In-call transient transport retries do not
count as new workflow failures. A `needs_human` caused by provider failures
is unlatched with `resume --clear-failures`: it appends a `kind: "clearance"`
record to `failures/` (with a reason — auditable, never deleting failure
history), and the failure count only considers entries after the most recent
clearance.

Implementation constraints:

- An atomically-created lock directory rejects concurrent runs of the same
  task; the owner record inside carries PID, hostname, task ID, and creation
  time. `resume` may reclaim a stale lock on the same host after confirming
  the PID is dead; when ownership cannot be proven or the PID is alive,
  automatic reclamation is refused and only an explicit `--force-unlock`
  proceeds.
- Every artifact is written to a temp file, `fsync`ed, then committed by
  atomic rename.
- `task.json` is the task-level authoritative source for the frozen
  requirement and run configuration; `requirement.md` is its readable
  projection.
- The Author's single authoritative output is one atomically-committed
  `author-output.json` containing provider metadata, the complete
  `planMarkdown`, and the resolutions. `plan.md` and `resolution.json` are
  idempotently derived readable projections, not independent model commits.
- Each atomic rename is an independent commit; `manifest.json` is only a
  per-round audit summary, never the sole commit marker needed for recovery.
  If a crash leaves a round without its manifest, the next `run`/`resume`
  backfills it idempotently during reconciliation.
- `state.json` is only a cache cursor. `resume` trusts the artifact graph,
  reconstructing phase/status/round precisely from `task.json`, round
  sources, reviews, overrides, failures, and the approval artifact. For
  example, when `author-output.json` is committed but `plan.md` or
  `resolution.json` is missing, the projections are re-derived from the
  authoritative output and the workflow proceeds to `reviewing` — the Author
  is never re-invoked.
- The plan hash in `review.json` is computed by the orchestrator from the
  exact `plan.md` handed to the Reviewer and written into the wrapper
  metadata; it never relies on the model echoing a hash.
- Final provider/workflow failures are written to `failures/NNNNNN.json`
  (`kind: "failure"`); human unlatching appends a `kind: "clearance"` record
  in the same sequence. Both the failure count and clearance state are
  reconstructable after `state.json` loss. Model, CLI, schema, or timeout
  errors never overwrite successfully committed plans or reviews.
- Once frozen, the requirement's hash is verified on every run; a changed
  requirement demands a new task or an explicit restart.
- Every provider call records the Git HEAD and dirty state at call time; each
  round's `manifest.json` summarizes the start/end repository snapshots. HEAD
  or dirty-state changes during a task produce a prominent warning but never
  block automatically, because a plan may legitimately review a working tree
  the user is actively editing.

Per-artifact recovery decisions:

| Current valid artifacts | Next action |
| --- | --- |
| Valid `task.json`/`requirement.md`, no round source | Invoke the Author to produce this round's `author-output.json` |
| Valid `author-output.json`; missing or stale `plan.md`/`resolution.json` | Re-derive idempotently from `author-output.json`; no model call |
| `author-output.json` and both projections valid; no `review.json` | Invoke the Reviewer directly |
| `review.json` with open critical findings; no next-round `author-output.json` | Invoke the Author to revise |
| Approving `review.json`; no `approval.json` | Enter `finalizing`; atomically produce the authoritative approval record |
| Valid `approval.json`; missing or stale `final.md` | Re-derive idempotently from the approved Author source |
| Both `final.md` and `approval.json` valid | Mark or restore `approved`; no further model calls |

A `plan.md` or `resolution.json` whose corresponding `author-output.json` is
missing or hash-invalid is artifact corruption with unprovable provenance:
the workflow enters `failed` and requires human handling — it neither re-runs
the Author nor sends orphaned projections to review.

## 4. Review protocol

### 4.1 Severity levels

- `blocker`: the plan cannot be implemented safely, violates an explicit
  requirement, its core technical approach is invalid, or it carries
  unacceptable data-corruption/security/permission risk.
- `major`: a critical scenario is missing or very likely implemented
  incorrectly; not fixing it causes significant rework.
- `minor`: a local improvement that does not block starting implementation.
- `nit`: wording, naming, or style only.

The approval condition is strictly:

```text
every historical blocker/major is resolved, withdrawn, or downgraded below critical
AND this round introduces no new blocker/major
```

`minor` and `nit` findings stay in the final review record but do not drive
further loop iterations.

Severity governs **blocking only**, never visibility. Two distinct sets are
derived from the finding map and must not be conflated:

- **active** (`activeFindings`) — every finding that is not closed, at every
  severity. The Reviewer must disposition each one; the Author must resolve
  each one. This is what both prompts carry.
- **blocking** (`blockingFindings`) — the active subset at `blocker`/`major`.
  This alone gates approval.

A severity left out of the active set is unreachable by both roles: it can never
be dispositioned, so it never closes, and the Reviewer re-files the same defect
under a fresh id every round. `minor` was in exactly that state until the two
sets were split, which is why a single CLI inconsistency could be filed four
times across four rounds under four ids.

### 4.2 Reviewer output

The Reviewer never edits the plan; it returns only a structured result:

```json
{
  "verdict": "changes_requested",
  "previousFindings": [
    {
      "id": "F001",
      "status": "resolved",
      "effectiveSeverity": null,
      "explanation": "Recovery now restores the snapshot before unpinning."
    }
  ],
  "newFindings": [
    {
      "relatedToFindingId": null,
      "relationKind": null,
      "noveltyRationale": "An independent persistence issue the previous round did not cover.",
      "severity": "blocker",
      "category": "correctness",
      "planSection": "B3",
      "problem": "The state-restore ordering can persist a polluted context.",
      "evidence": ["src/anchor.rs", "plan.md#B3"],
      "requiredChange": "Restore the clean snapshot first, then run unpin_to_stash."
    }
  ],
  "summary": "One blocker remains."
}
```

The `review.json` the orchestrator writes to disk is a wrapper, never the raw
model output:

```json
{
  "meta": {
    "planSha256": "...",
    "provider": "codex",
    "model": "...",
    "cliVersion": "...",
    "promptSha256": "...",
    "startedAt": "...",
    "completedAt": "...",
    "usage": {},
    "costUsd": null,
    "gitHead": "...",
    "gitDirty": true
  },
  "review": {
    "verdict": "changes_requested",
    "previousFindings": [],
    "newFindings": []
  }
}
```

`meta.planSha256` is produced entirely by the orchestrator and gates the
loop. The model never needs to echo a 64-character hash; if an echo is ever
added for diagnostics, it may only be a soft-checked log field and must never
decide review staleness.

The Reviewer must:

- give a `resolved`, `still_open`, `withdrawn`, or `severity_changed`
  disposition for every **active** finding — every severity, not just
  critical — excluding those a human override closed;
- back every new finding with repository evidence, the plan section it
  targets, and the required change;
- distinguish technical-correctness problems from pure implementation
  preference;
- set `relatedToFindingId` on every new finding (`null` when unrelated), and
  when related, classify the link with `relationKind`:
  - `recurrence` — the same underlying defect resurfacing after a failed fix.
    It inherits the ancestor's `criticalReviewStreak + 1`, so a defect that
    keeps returning under new IDs still converges on the stall gate.
  - `adjacent` — a distinct defect near the ancestor. Starts a fresh streak.

  `noveltyRationale` remains the Reviewer's argument for why the finding is not
  a resubmission. The orchestrator validates only field presence, ID
  references, and `relatedToFindingId`/`relationKind` agreement; it never
  attempts semantic-equivalence judgment. Classification is therefore the
  Reviewer's honest report, and the Reviewer is given its closed findings as
  history precisely so it can recognize a recurrence at all.

Finding IDs are assigned by the orchestrator. Models may only reference
existing IDs and can neither rewrite them nor reuse another finding's ID.

Finding lifecycle:

- `still_open`: the problem persists; severity stays as-is by default.
- `resolved`: the Author's revision fixed it.
- `withdrawn`: the Reviewer accepts the Author's counter-evidence; the
  finding no longer stands.
- `severity_changed`: the problem persists at a different severity;
  `effectiveSeverity` and a rationale are mandatory. Downgrading to
  `minor`/`nit` stops blocking approval; upgrading to `blocker`/`major`
  continues to block.

The orchestrator normalizes dispositions leniently: a redundant
`effectiveSeverity` echoed on a non-`severity_changed` status (on a closed
finding, or equal to the current severity) is coerced back to `null` with a
log line; only an undeclared severity change — a different level without
`severity_changed` — is invalid output. Rejected model output is preserved
alongside the error in the corresponding failure record for diagnosis.

`verdict` has exactly two legal values: `approved` and `changes_requested`.
The orchestrator recomputes the expected verdict from finding state; a model
verdict that disagrees is invalid Reviewer output. With N reviewers, each
slot's self-check runs over *that slot's own output* (with provisional
`P<k>` ids, since real ids do not exist before the merge), and the **round's**
verdict is composed from the merged set through the same
`collectFindings`/`blockingFindings` pair that computes the gate — a slot that
self-consistently approved while a peer filed a blocker cannot finalize
anything.

#### Concurrent reviewers: fan-out, barrier, merge

- **One prompt per round, byte-identical across slots.** No reviewer's
  findings enter another reviewer's prompt, and a reviewer is never told it is
  one of several (`sanitizedFinding` carries no `raisedBy`). `sha256(prompt)`
  is the round's fingerprint: a committed capture belongs to the round's
  current attempt iff its recorded `promptSha256` matches, and any other
  fingerprint supersedes its slot (in practice only the overrides document —
  serialized into every prompt — can move mid-round). This is what reconciles
  partial recovery with the barrier: a failure-driven resume re-runs only the
  failed slot, while a human override mid-round re-fans-out the whole round,
  because the peers answered a question that no longer exists.
- **The barrier is a predicate over committed artifacts.** The round merges
  iff every roster slot has a committed, fresh capture; the merge reads files,
  never in-memory results, so a fresh run and a resume share one code path.
  The author runs once per round, after the merge.
- **Id allocation happens only at the merge** (`lib/merge.mjs`), walking the
  roster in slot order and each capture in array order — race-free by
  construction and deterministic under any completion order. A capture's
  same-output reference (`F(base+k)`, today's accepted N=1 behavior) is
  rewritten at capture to a slot-local `P<k>` and resolved at merge against
  that slot's own allocation, never a peer's.
- **Arbitration is most-open-wins.** A finding stays open at the highest
  severity any slot assigns it and closes only if every slot closes it; ties
  go to the lowest slot index. Dispositions are the dual of the union: any
  other rule would make the merged jury weaker than its strictest member. All
  N dispositions are recorded under `arbitration`; a stubbornly wrong reviewer
  drives the existing stall gate (§7) to a human, which is the designed escape.
  Overrides are not arbitrated — they apply after the fold, as always.
- **Failure budgets are per slot** (`failures/` records carry `slot`; legacy
  records normalize to `R1`), so a flaky slot latches `needs_human` without
  spending its peers' budgets, and `resume` re-runs only slots without fresh
  captures.

### 4.3 Author output

Both the initial draft and every revision return a complete plan, never a
patch:

```json
{
  "planMarkdown": "# Complete plan\n...",
  "resolutions": [
    {
      "findingId": "F001",
      "action": "accepted",
      "changedSections": ["B3"],
      "explanation": "Reordered state restoration and unpinning."
    }
  ]
}
```

In revision rounds the Author must address every **active** finding — every
open severity, not only the blocking ones. A `minor` is cheap to fix while the
plan is still text, and answering it is what closes it: an unanswered `minor`
stays open and is handed back next round. Closing one via `rejected` with a
reason is a complete answer, so this obligation costs a sentence, not a round.
Allowed actions:

- `accepted`: the plan was changed as required.
- `rejected`: not adopted — must include verifiable repository evidence and a
  technical rationale.
- `superseded`: replaced by a broader approach change, naming the new
  sections.

The orchestrator rejects Author output that misses any required finding
resolution; extra resolutions referencing non-required findings are kept
verbatim (as the Author's own statements) and never cause rejection.

With several reviewers, two findings can independently describe one defect.
Each resolution therefore carries `coversFindingIds`: one resolution answers
its own `findingId` plus every ID listed there, with one action and one
explanation — equivalence is the Author's judgment, never the orchestrator's
(mechanical or LLM dedup would silently delete a real finding on a false
merge; a false split costs the author one sentence). Every active finding must
be covered exactly once across all resolutions. The author prompt shows each
finding's `raisedBy` slot id — never the provider or model behind it, which
would invite dismissing findings by reputation.

`author-output.json` stores exactly what the provider returned; every reader
normalizes in memory (`coversFindingIds: []` where absent) before validating.
This keeps the provider-common schema fully-required while accepting legacy
outputs on disk and providers that omit the field — and projections and hashes
are always taken from the stored bytes, so normalization never rewrites a
committed round.

After validating the model's structured output, the orchestrator first
atomically writes the authoritative wrapper:

```json
{
  "meta": {
    "provider": "claude",
    "model": "...",
    "cliVersion": "...",
    "promptSha256": "...",
    "startedAt": "...",
    "completedAt": "...",
    "usage": {},
    "costUsd": null,
    "gitHead": "...",
    "gitDirty": true
  },
  "output": {
    "planMarkdown": "# Complete plan\n...",
    "resolutions": []
  }
}
```

Only after `author-output.json` commits are `plan.md` and `resolution.json`
written. Every projection is rebuildable from the wrapper, and
`manifest.json` records both source and projection hashes. If a crash lands
between any two renames, `resume` merely re-derives projections — no model
spend is repeated.

v1 keeps the "one structured output carrying the full `planMarkdown` plus
resolutions" design, with dedicated integrity handling:

- The prompt requires at least one H1 plus the fixed headings `## Goal`,
  `## Implementation`, and `## Verification`; the body may be written in any
  language.
- Beyond JSON Schema, the orchestrator validates that the plan is non-empty,
  the fixed headings are present, the ending is not an obvious truncation,
  and a configurable minimum length is met.
- When the CLI explicitly reports truncated output or unclosed JSON, or the
  Author payload/schema fails in a truncation-shaped way, one dedicated
  fresh-session retry is allowed; the retry prompt demands compressing
  non-critical prose and returning complete JSON.
- A second failure records a provider failure without saving any incomplete
  `plan.md`. Reviewer schema/logic errors never get this dedicated retry —
  only the normal transient-transport retry applies to them.
- If long plans still fail frequently in practice, v2 may split into a pure
  Markdown plan call plus a small resolutions JSON call; v1 does not ship two
  protocols at once.

## 5. Provider adapters

The shared schemas use only the common subset of Claude and OpenAI
structured output: every object declares all properties `required` and sets
`additionalProperties: false`; nullability uses type arrays; content keywords
like `minLength`, `pattern`, and `format` are avoided. The schema
`description` records this constraint; heading/length/finding-reference rules
are enforced by explicit orchestrator checks outside Ajv.

### 5.1 Codex

Invocation shape:

```bash
codex exec \
  --cd <repo> \
  --sandbox read-only \
  --ephemeral \
  --ignore-user-config \
  --disable hooks \
  --output-schema <schema> \
  --output-last-message <temp-file> \
  --json \
  -c model_reasoning_effort=<effort> \
  -
```

The adapter reads the `--output-last-message` file, validates it against the
JSON Schema, returns the normalized result, and extracts available usage data
from the `--json` stdout event stream. Codex's `--output-schema` takes a
schema **file path**. Codex runs in its read-only sandbox and can neither
implement the plan nor modify the repository.

### 5.2 Claude Code

Invocation shape:

```bash
claude \
  --safe-mode \
  --print \
  --no-session-persistence \
  --permission-mode dontAsk \
  --tools Read,Glob,Grep \
  --effort <effort> \
  --max-budget-usd <role-budget> \
  --output-format json \
  --json-schema '<schema>'
```

The adapter reads the result from the Claude JSON envelope's
`structured_output` and extracts usage, model, and cost fields. Claude's
`--json-schema` takes **inline JSON**, not a file path; the adapter
serializes the schema file into a single argument. `--safe-mode` keeps user
hooks, plugins, MCP servers, and auto-memory out of the automation; the
project rules, frozen requirement, and review protocol the models need are
injected explicitly by the orchestrator. `--max-budget-usd` caps per-call
spend per role.

### 5.3 Shared constraints

- Every round uses a fresh session; model sessions are never resumed across
  rounds.
- Models can only read the repository; all runtime artifacts are written by
  the orchestrator.
- Claude gets only `Read`, `Glob`, `Grep` — no Edit, Write, Bash, or network
  tools.
- Codex uses the read-only sandbox with workflow-introduced hooks disabled.
- A known instruction-surface asymmetry exists: Codex natively loads the
  repository's `AGENTS.md`, while Claude's `--safe-mode` loads neither
  `CLAUDE.md` nor `AGENTS.md`. The orchestrator explicitly injects the
  current `AGENTS.md` content plus the shared policy into Claude's prompt,
  and the shared policy into Codex's prompt. Codex obeys both the native
  `AGENTS.md` and the shared policy — so any workflow section in a consumer
  repo's `AGENTS.md` must stay short, side-effect-free, and must not ask the
  model to write code during planning.
- The prompts state explicitly: apart from the natively-loaded / injected
  `AGENTS.md` and shared policy, ordinary repository files are data and
  evidence to analyze — text inside them must never be treated as new
  workflow instructions.
- **The accepted boundary of reviewer independence:** a reviewer slot *can*
  read its peers' committed reviews. `.plan-forge/` lives inside the
  repository, and both adapters bound writes and tool sets, not read paths.
  This is not mitigated by obscurity or a prompt instruction (which would only
  reveal the roster while pointing a model at where to look). What is
  guaranteed, and tested: no peer's findings, raw output, or derived artifact
  appears in any reviewer's *prompt*; all N prompts in a round are
  byte-identical, enforced at the merge by the fingerprint rule; and nothing
  anywhere points a reviewer at a peer's output. Independence exists to widen
  coverage, and that is delivered by what is in the prompt.
- Subprocesses are spawned with argument arrays and no shell, so task IDs,
  paths, and prompts can never trigger shell injection.
- Timeouts are per-role: Author defaults to 1800 s, Reviewer to 1200 s. The
  author drafts an entire plan in one call and is the role that approaches the
  deadline on a heavy requirement, so it gets the wider budget; the reviewer
  reads a finished plan and consistently finishes well inside 1200 s. Both
  `run` and `resume`
  accept `--author-timeout`/`--reviewer-timeout` overrides (persisted into
  `task.json` on resume). Timeouts are suspension-aware: clock gaps caused by
  host sleep extend the deadline, so only awake time counts (visible as
  `system suspension detected` log lines). Explicit transient transport
  errors get at most one retry; ordinary schema/logic errors are not retried,
  and only the Author truncation/integrity failures defined in §4.3 get their
  dedicated single retry.
- The orchestrator writes phase changes and artifact commits to the per-task
  `run.log`. While a provider runs, a heartbeat is logged every 15 seconds
  and the provider's stderr is mirrored live — prefixed — to both the
  terminal stderr and `run.log`; stdout is never used for progress logging.
- Logs and artifacts never record environment variables, auth tokens, or the
  full process environment.
- Every invocation records the provider, actual model ID, CLI version, prompt
  SHA-256, start/end times, Git HEAD, dirty state, and whatever token usage
  and cost the provider returns. Fields the provider does not return are
  written as `null`, never guessed. When Claude runs without an explicit
  `--model`, the primary model is derived from the envelope's `modelUsage`
  (largest output-token entry). Codex's `--json` event stream carries no
  model name, so without `--model` its `meta.model` is `null`, meaning "the
  codex CLI built-in default" (unaffected by user config under
  `--ignore-user-config`; e.g. gpt-5.5 at 0.139.0). Reasoning efforts are
  pinned explicitly by the workflow and recorded in wrapper `meta.effort`:
  defaults claude=`xhigh` (`--effort`) and codex=`high`
  (`-c model_reasoning_effort=…`), overridable via
  `--author-effort`/`--reviewer-effort`.
- Claude supports a hard per-call spend cap; the Codex CLI currently has no
  equivalent in-run cap, so v1 records Codex usage post-call and relies on
  round limits and human configuration to bound total spend.
- Author, Revision Author, Reviewer, and the shared policy use separate
  prompt templates. The assembler injects the frozen requirement, the
  current/previous plan, active finding IDs, Author resolutions, and
  effective overrides in fixed delimited blocks; it never injects the process
  environment, credentials, or unfiltered logs.

Capability references:

- [Codex non-interactive mode](https://developers.openai.com/codex/noninteractive)
- [Codex AGENTS.md](https://developers.openai.com/codex/guides/agents-md)
- [Claude Code programmatic usage](https://code.claude.com/docs/en/headless)
- [Claude Code project memory and AGENTS.md import](https://code.claude.com/docs/en/memory)

## 6. CLI interface

```bash
plan-forge run \
  --task anchor-context \
  --requirement docs/requirements/anchor.md \
  --author claude \
  --reviewer codex

plan-forge doctor    # preflight: CLI presence, versions, every required flag (zero model calls)
plan-forge resume --task anchor-context
plan-forge status --task anchor-context
plan-forge show --task anchor-context
plan-forge override \
  --task anchor-context \
  --finding F001 \
  --disposition withdrawn \
  --reason "reviewer accepted new repository evidence"
```

Consumer repositories typically add thin passthrough wrappers (e.g. `just`
recipes) so their task runner and this CLI share one set of named arguments —
if you do, make sure quoting survives the passthrough.

Supported options:

```text
--author claude|codex
--reviewer claude|codex      # repeatable; omitted → one codex slot (today's default)
--max-rounds 6
--max-provider-failures 2
--author-timeout 1800
--reviewer-timeout 1200
--claude-author-max-budget-usd <amount>
--claude-reviewer-max-budget-usd <amount>
--publish <path>
--author-model <model>
--reviewer-model <model>
--force-unlock
--clear-failures   # resume only: reset the provider-failure count (appends a clearance audit record); pair with --reason
--author-timeout / --reviewer-timeout   # also on resume: updates the role timeouts in task.json
--author-effort / --reviewer-effort     # reasoning effort, also on resume. Defaults: claude=xhigh, codex=high.
                                        # claude enum: low|medium|high|xhigh|max; codex enum: none|minimal|low|medium|high|xhigh
--publish-dir <dir>                     # auto-archive directory for approved plans (default docs/plans, must be inside the repo); persisted per task
--requirement <file|->                  # requirement source file, or - for stdin
--requirement-text <text>               # inline requirement (exactly one of the two requirement channels)
```

The `override` subcommand additionally accepts:

```text
--finding <finding-id>
--disposition withdrawn|severity_changed
--severity blocker|major|minor|nit   # required with severity_changed
--reason <non-empty-text>
```

Author and Reviewer must use different providers by default; debugging with
the same provider requires an explicit `--allow-same-provider`. The flag
guards **author vs. reviewer** only: with a roster it is required iff any
slot's provider equals the author's, while two reviewer slots sharing a
provider — or a model — need no flag (a same-model pair is a legitimate
sampling-variance probe).

**Roster binding rules** (`lib/roster.mjs`): fewer than two `--reviewer`
occurrences → exactly one slot, and every slot-scoped flag
(`--reviewer-model`, `--reviewer-effort`, `--claude-reviewer-max-budget-usd`)
binds to it from the last-wins map regardless of order — today's behavior
byte-for-byte, including the zero-occurrence `codex` default. Two or more →
binding is positional: each slot-scoped flag binds to the most recent
preceding `--reviewer`, and a slot-scoped flag before the first `--reviewer`
is an error.

**Slot models are late-bound at N=1, pinned at N>1.** A single-reviewer task
stores the raw flag or `null` and resolves the environment on every run —
today's contract. A multi-reviewer roster resolves each slot at creation
(flag → env var) and refuses a slot that resolves to nothing: the audit
record must name every juror, and `meta.model: null` means "whatever the
provider CLI defaulted to that day", which is unknowable afterward — the
Background's gpt-5-mini incident is exactly that failure. An env-provided
model is a valid pin. On load, a pinned slot's capture must record the pinned
model; an N=1 slot pins nothing, so the check never runs there.

On success the CLI prints the final status and the absolute path of
`final.md`; `show` prints the final Markdown. `status` never calls a model
and never costs anything; with a fan-out in flight it reports
`pendingReviewerSlots` (slots with no capture, or a superseded one).

## 7. Anti-livelock and human adjudication

Any of the following triggers `needs_human`:

- `max-rounds` reached.
- The same finding stays open at critical severity across two consecutive
  re-review rounds: its counter is 0 when first reported; the first
  `still_open` / critical-severity `severity_changed` re-review counts 1; a
  second consecutive unresolved re-review counts 2 and triggers
  adjudication. The Author therefore gets two repair attempts, and status
  oscillation cannot evade the counter.
- The same finding recurring under a **new ID** counts the same way. A
  `recurrence` link inherits `ancestor.criticalReviewStreak + 1`, and the
  streak now survives the ancestor being closed, so "resolve F001 → re-file
  the identical defect as F013" accumulates toward adjudication instead of
  resetting it. Without this, a loop where the Author fixes the letter of each
  finding while the Reviewer re-finds its substance burns every round at full
  cost and lands on `max-rounds` with no signal that it was stuck. The counter
  depends on the Reviewer classifying honestly; it is given its closed findings
  as history so the classification is possible, but the orchestrator cannot
  verify it semantically.
- The Author fails to address every open critical finding.
- The frozen requirement's hash changes.
- Provider/workflow failures in the same phase reach `maxProviderFailures`
  consecutively.

v1 deliberately excludes "semantically equivalent findings" and
"irreconcilable interpretations" as automatic triggers, because neither can
be judged mechanically and reliably by the orchestrator. The Reviewer
provides audit signals via `relatedToFindingId` and `noveltyRationale`;
whether something is a duplicate is left to later human audit or a dedicated
v2 mechanism.

After entering `needs_human`:

- `final.md` is neither produced nor updated.
- The current plan and every review and resolution are preserved.
- On a **deliberate** stop the plan and a decision brief are published to
  `docs/plans/needs_human/<task-id>.md` (§2). `status` reports the same
  finding IDs and arguments as JSON; the published brief is the same content
  aimed at the human who has to rule on it.
- A human can start a new task with a changed requirement, or close/adjust
  findings via explicit overrides and then `resume`.
- The two overrides (`withdrawn`, `severity_changed`) express only *"the
  reviewer is wrong"* and *"real, but not blocking"*. Neither can express
  *"the frozen requirement contradicts itself"* — the case where the Author
  and Reviewer agree the plan is as good as the requirement permits. That is a
  requirement change, and requirements are immutable: it needs a new task id.
  Overriding past it would approve a plan that still contains the defect,
  which is the one outcome the gate exists to prevent.
- Clearing the last blocker via override does **not** approve the plan. Only a
  Reviewer verdict of `approved` finalizes; `runWorkflow` reads the stored
  verdict rather than recomputing the gate from findings. A ruling clears
  *findings*, and the plan it leaves behind may still be wrong: a
  `severity_changed` ruling keeps a real defect in the plan, several rulings
  interact, and any of them can introduce flaws downstream that nobody has
  looked for. So a ruling that clears every blocker buys exactly one more
  round — the Author revises with the overrides visible, the Reviewer
  re-reviews — and that round runs even past `max-rounds`, because a human
  asking to continue is the authority the limit exists to defer to. If
  blockers remain, the human has not cleared the path and the task stays
  stopped. Without this, an override would mint `gate.verdict: 'approved'` in
  `approval.json` for a plan whose only review said `changes_requested` — a
  human fiat wearing a review's clothes, in the audit record.
- A `needs_human` caused by provider failures (network down, expired CLI
  auth) is unlatched — after fixing the environment — with
  `plan-forge resume --task <id> --clear-failures --reason "<why>"`; never
  delete files under `failures/` by hand.

Human overrides live in an independent, auditable `overrides.json` and never
modify historical reviews:

```bash
plan-forge override \
  --task anchor-context \
  --finding F001 \
  --disposition withdrawn \
  --reason "reviewer accepted new repository evidence"
```

`overrides.json` example:

```json
{
  "schemaVersion": 1,
  "entries": [
    {
      "id": "O001",
      "findingId": "F001",
      "disposition": "withdrawn",
      "effectiveSeverity": null,
      "reason": "reviewer accepted new repository evidence",
      "createdAt": "...",
      "actor": "human",
      "source": "cli"
    }
  ]
}
```

v1 supports two human dispositions, `withdrawn` and `severity_changed`; the
latter requires `--severity blocker|major|minor|nit`. The orchestrator
updates the file atomically with append-only semantics, computes effective
state from the last override per finding, and surfaces human intervention
explicitly in `status`, subsequent prompts, gate computation, and
`approval.json`. After an override, `resume` proceeds to `finalizing` if all
critical findings are closed, otherwise stays in `needs_human` or continues
the loop when conditions allow.

A plan is never auto-approved because of cost, timeouts, round exhaustion,
or provider unavailability.

## 8. Consumer repository integration

A repository adopting plan-forge typically updates:

- its task runner (optional): thin passthrough recipes for run / resume /
  status / show / override / test;
- `.gitignore`: add `.plan-forge/`;
- its agent instruction file (`AGENTS.md` or equivalent): a short section
  with the command entry points and the rule that plan-review agents never
  implement code or create commits, and that human overrides must go through
  the CLI to stay auditable.

The full shared protocol lives in `prompts/shared-policy.md`; the consumer's
`AGENTS.md` should keep only stable entry points and key rules so ordinary
coding sessions don't load review-loop details they don't need.

## 9. Test strategy

Tests use Node's built-in `node:test`; the only dependency is Ajv 8, declared
in this package's own `package.json`.

### 9.1 Unit tests

- Severity gate: only `blocker`/`major` block approval.
- Historical finding closure: every critical finding must receive
  `resolved`, `still_open`, `withdrawn`, or `severity_changed`, gated by
  effective severity.
- Finding ID assignment, `relatedToFindingId` reference checks, and
  `noveltyRationale` presence — semantic equivalence is deliberately
  untested.
- Requirement and plan hash validation, plus orchestrator-generated review
  wrapper metadata.
- Task ID, artifact path, and publish path traversal rejection.
- Atomic writes, lock contention, dead-PID stale-lock reclamation, corrupted
  state detection.
- Complete phase/status transitions, post-clearance failure-count reset, and
  the `needs_human` threshold.
- Deterministic projection of `author-output.json` into
  `plan.md`/`resolution.json` with hash verification.
- Append-only `overrides.json` updates, finding references,
  disposition/severity combinations, and gate merging.
- The shared schema subset and the Ajv commit gate; prompt-injection
  completeness and environment-variable non-leakage.
- Stage logs mirrored to both terminal and `run.log`; live provider stderr
  forwarding; heartbeats at fixed intervals during long calls.
- Merge semantics (`test/merge.test.mjs`, pure): id allocation deterministic
  under any completion order and race-free by construction; most-open-wins
  arbitration with every disposition recorded and ties to the lowest slot;
  verdict composed from the merged set, never inherited; the N=1 merge
  deep-equals today's normalizer modulo provenance; slot-local `P<k>`
  references bind to their own slot, never a peer, and an out-of-range one is
  a named merge error, not a committed artifact.
- Roster binding (`test/roster.test.mjs`, pure): the zero/one/many
  `--reviewer` rules, today's error strings, and the author-vs-reviewer scope
  of `--allow-same-provider`.
- Dup coverage: one resolution covering many findings, double coverage
  rejected, coverage gaps still caught; the merged-vs-reviewer schema drift
  guard.

### 9.2 Fake-provider integration tests

- A drafts → B returns a blocker → A revises → B approves → `final.md`.
- Exact round accounting: a finding counts 0 at first report, 1 after the
  first critical re-review, and only enters `needs_human` after the second.
- No approval while a major remains open.
- Normal approval with only minor/nit findings.
- The Reviewer never echoes the plan hash; the orchestrator wrapper must bind
  the exact input plan hash.
- Author output missing a critical resolution is rejected before re-review.
- Author truncation/integrity failure triggers exactly one dedicated retry; a
  second failure saves no incomplete plan.
- Malformed JSON, ordinary schema errors, and timeouts never damage existing
  artifacts.
- After deleting `state.json`, the same-phase consecutive-failure gate is
  rebuilt from `failures/`.
- After a provider-failure latch, `--clear-failures` unlatches and a retry
  succeeds; an empty clearance (nothing to clear) is refused.
- A round manifest lost to a crash is backfilled on the next resume.
- Interruptions at drafting, after `author-output.json` but before one or
  both projections, after review but before the next round, and during
  finalizing all resume precisely — without re-invoking any successful
  provider call.
- Orphaned `plan.md`/`resolution.json` are never sent to review and never
  trigger an Author re-run; they must be rebuilt from a valid
  `author-output.json`.
- Round exhaustion or persistent non-convergence enters `needs_human`.
- Concurrent execution of the same task is rejected by the task lock.
- Each round's manifest records model/CLI/prompt/usage/cost plus the Git
  HEAD/dirty snapshots; repository changes warn but never block.
- Human overrides never rewrite review history, can close or adjust findings,
  and appear fully in the final audit record.
- Concurrent reviewers (`test/concurrent.test.mjs`): the author runs once per
  round, only after all captures and the merge; prompts are byte-identical
  across slots, no `raisedBy` reaches a reviewer, the author sees slot ids and
  never providers or models; a failure-driven resume re-runs only the failed
  slot with the healthy capture byte-unchanged; a committed round survives a
  later override untouched, while an override landing mid-round supersedes all
  captures and re-fans-out; per-slot failure budgets latch independently; a
  hand-written legacy task resumes through the v1 branch into the v2 layout;
  merged captures are hash-verified on every load (deleted/edited/unknown all
  named errors); a merged round cannot masquerade as legacy or shed
  provenance; a mismatched adapter array spends zero provider calls; a
  multi-reviewer stall publishes `reviewer=<p1>,<p2>` with a stable
  `stoppedAt`; N>1 model pinning at creation, N=1 late binding preserved.

### 9.3 Live provider smoke test

Real Claude/Codex tests are strictly opt-in; the default suite never spends
model tokens:

```bash
PLAN_FORGE_LIVE=1 node --test test/live.test.mjs
```

Using a low-risk, tightly-scoped test requirement, it verifies:

- both CLIs are authenticated and versioned on this machine;
- both ends' schema output parses through the adapters;
- the read-only restrictions hold — the working tree gains no implementation
  changes;
- at least one full "finding → revision → approve" cycle completes.

A two-slot live smoke (one `claude` and one `codex` reviewer slot) exercises a
merged round with both `meta.promptSha256` values equal to the round's and
every merged finding attributed. Note it needs `--allow-same-provider` when
the author is `claude` (one slot then shares the author's provider), and both
slots must resolve a model (N>1 pins at creation).

## 10. Implementation order (historical)

1. Define the `author-output.json`/review wrappers, derived projections, JSON
   Schemas, severities, finding lifecycle, human overrides, and approval
   rules.
2. Implement path validation, the PID-bearing task lock, per-artifact atomic
   commits, precise recovery, manifests, and the full state machine.
3. Implement the fake provider and drive the full loop and recovery paths
   with integration tests.
4. Implement the Codex provider adapter.
5. Implement the Claude Code provider adapter.
6. Implement `run`, `resume`, `status`, `show`, `override`, and publishing.
7. Wire up consumer-repo integration (task runner, `.gitignore`, agent
   instruction files).
8. Run the full zero-cost suite, then one opt-in live two-model smoke test.
9. Update this document from the smoke-test results and mark the status
   implemented.

## 11. Acceptance criteria

- One command starts a Claude/Codex review loop from a frozen requirement.
- Every round's `author-output.json`, plan projection, resolution projection,
  review, and manifest is independently auditable.
- Every revision outputs a complete plan, never depending on model session
  history or incremental patches.
- Any open `blocker` or `major` blocks final approval.
- With no critical findings, `.plan-forge/<task-id>/final.md` and
  `approval.json` are produced and `docs/plans/<task-id>.md` is published
  automatically.
- After interruptions or provider failures, recovery is artifact-precise; a
  committed `author-output.json` is never re-generated because projections or
  a round manifest are missing.
- The review's plan hash is orchestrator-bound: a model mistyping a hash can
  neither fake staleness nor review the wrong plan version.
- The same task cannot run concurrently; dead-process locks reclaim safely;
  no path argument can write outside the allowed directories.
- Non-convergence ends explicitly in `needs_human` — never a silent failure
  or auto-approval.
- Default tests never call real models; the live smoke test is explicit
  opt-in.
- During a run, nothing outside `.plan-forge/` is modified, with one
  sanctioned exception: on approval, `finalize` idempotently publishes the
  plan to `docs/plans/<task-id>.md` (with a one-line provenance comment:
  task/round/author/reviewer/approvedAt/planSha256), recording the path in
  `approval.json.publishedPath`. The models themselves never have write
  access.
- Audit records include the actual provider/model, CLI versions, prompt
  hashes, Git snapshots, and whatever usage/cost the providers return.
- Human overrides have an explicit CLI, an append-only artifact, and defined
  gate-merge rules — they never implicitly rewrite model review history.

The approved plan is always available via:

```bash
plan-forge show --task <task-id>
```

<!-- plan-forge: task=concurrent-reviewers-merge round=6 author=claude reviewer=codex status=approved approvedAt=2026-07-16T14:51:58.496Z planSha256=ec1cc18ba19b42e42b0a758905b3e11855f602a33889b4368a38b0370a8dad49 requirementSha256=b78e8347dc41718d1c5f8b9eaa134cb339441afa3ad15d11f54b4e6f308804ed -->

# Concurrent reviewers: fan-out, barrier merge, and one author revision

## Goal

Let a task run **N reviewer slots (N ≥ 1)** against one plan in a single round, concurrently. When every slot has returned, merge their outputs into **one merged round review** and drive **one** author revision from it. Coverage is the point: the union of N independent reviews is strictly more informative than any one, and the Background's evidence (Claude found 3 defects, gpt-5.6-sol found 2 of those plus 1 Claude missed, gpt-5-mini found 0 and approved) shows single-reviewer variance decides between "no defects" and "two majors" on identical text.

Four properties hold together:

1. **Independence is prompt-level, and it is real at that level.** No reviewer's findings enter another reviewer's prompt. Every slot in a round receives a **byte-identical** prompt — byte-identical *across that round's slots*, which is the invariant the union needs — so the merge draws from exactly the distribution the Background measured. (At N=1 this equals today's reviewer prompt on the initial round; a revision round additionally serializes the author's `coversFindingIds`, an additive field the reviewer ignores — §9.) This is enforced, not asserted: a round merges only from captures whose recorded `promptSha256` equals the round's prompt (§7.3). Enforced OS/process isolation is **not** attempted; same-UID readability of a committed peer review is an accepted, documented boundary (§10).
2. **The barrier is a predicate over committed artifacts, not an in-memory join.** A round merges iff every roster slot has a committed review file answering the round's current question. The author runs once, after the merge, on a fresh run and on a resume alike.
3. **Committed rounds are frozen.** The merge is the freeze point: `review.json` is written once and thereafter read verbatim, never recomputed. A later override never re-derives, re-validates, or rewrites it. What *is* checked on load is the audit chain — frozen capture bytes against the hashes the merge itself recorded (§7.1) — a check no current state can perturb. Which checks apply is decided by the format the round **declares** in its own bytes (§2, §7.1), so no artifact can opt out of verification by omitting a field.
4. **N=1 goes through the same code.** There is no parallel single-reviewer path. N=1 produces an equivalent plan, findings, verdict, and published artifacts, and every existing task resumes without migration. Where a shared mechanism would have changed N=1's observable behavior — model resolution (§1.2), the CLI's default reviewer (§1.3), same-output finding relations (§4.1.1) — N=1 keeps today's behavior and the new machinery is built to preserve it rather than around it.

This plan does **not** attempt enforced isolation. Two earlier framings (`concurrent-reviewers-v2`, `concurrent-reviewers-atomic-round`) both stalled on exactly that blocker, and the human ruling in the frozen requirement dropped it. Per-slot commit — which is what makes a peer readable — is the same mechanism that makes AC8's partial recovery work; §10 states the boundary plainly instead of claiming a guarantee.

## Implementation

### 0. The four open questions, answered

| | Answer | Where |
|---|---|---|
| **Q1** conflict disposition winner | **Most-open-wins**: a finding stays open at the highest severity any slot assigns it; it closes only if every slot closes it. Ties → lowest slot index. | §4.2 |
| **Q2** where dup handling happens | **Author-level**, via a new `coversFindingIds` on resolutions. No merge-time equivalence detection, no LLM dedup. | §5 |
| **Q3** tell a reviewer it is one of several | **No.** Prompts are byte-identical across a round's slots (§6); the reviewer's finding view is unchanged from today. | §6 |
| **Q4** partial re-run vs. committed peers | **Re-run only the failed slot**, peers stay on disk, nothing about them enters the prompt. The one exception: if a human override changed what the round is asking, the whole fan-out re-runs, because the peers answered a different question. | §7.3, §7.4, §10 |

### 1. The reviewer roster

A **slot** is one reviewer configuration, identified by 1-based position (`R1`, `R2`, …). Position, not provider, is the identity: the requirement's own evidence compares `codex`+`gpt-5.6` against `codex`+`gpt-5-mini`, two slots sharing a provider.

#### 1.1 `task.json`

The roster is frozen at task creation. `reviewerSlots(task)` in `lib/workflow.mjs` normalizes both storage forms:

```js
export function reviewerSlots(task) {
  if (Array.isArray(task.reviewers) && task.reviewers.length) {
    return task.reviewers.map((slot, index) => ({
      id: `R${index + 1}`, index: index + 1,
      provider: slot.provider, model: slot.model,
      effort: slot.effort ?? null, claudeMaxBudgetUsd: slot.claudeMaxBudgetUsd ?? null
    }));
  }
  return [{
    id: 'R1', index: 1,
    provider: task.reviewer, model: task.reviewerModel ?? null,
    effort: task.reviewerEffort ?? null, claudeMaxBudgetUsd: task.claudeReviewerMaxBudgetUsd ?? null
  }];
}
```

- **New tasks always write `reviewers: [...]`**, N=1 included, and omit `reviewer` / `reviewerModel` / `reviewerEffort` / `claudeReviewerMaxBudgetUsd`. Exactly one form is present, so the two can never drift.
- **Legacy tasks** have no `reviewers` key and normalize to a one-slot roster. This is not compatibility cruft that can rot — it is the shape every task on disk today has.
- `loadContext`'s check `['claude','codex'].includes(task.reviewer)` becomes: exactly one form is present, the normalized roster is non-empty, and every slot's provider is `claude` or `codex`. Failure message: `task.json reviewer configuration is invalid`. Model resolution is **not** checked here: `loadContext` also serves read-only commands like `status`, and a task must stay inspectable regardless of what the current environment exports.
- `task.reviewerTimeoutMs` stays **round-level**, shared by all slots. A round is bounded by its slowest slot; a per-slot timeout would add configuration surface for nothing.
- **The roster's shape cannot change on resume.** There is no flag to change it (`updateTaskSettings` touches only timeouts and effort), and this stays true: adding, removing, or re-providering a slot mid-task would make finding lineage across rounds incomparable, since round 1's merged set came from a different jury than round 2's. That immutability is load-bearing beyond lineage — §7.1 checks a committed round's roster manifest against `task.json`, which is only sound because the roster is as frozen as the round is. A slot's *model* is a narrower question with a different answer, and §1.2 gives it: pinned at creation when N>1, late-bound from the environment at N=1 exactly as today.

**`reviewerLabel(task)`** — `reviewerSlots(task).map((slot) => slot.provider).join(',')` — is the one expression both published headers use for `reviewer=`. Today `publishForHuman` (`lib/workflow.mjs:169-170`) and `finalize` (`lib/workflow.mjs:511`) each interpolate `context.task.reviewer` directly, which is `undefined` for any task storing a roster. At N=1 the helper returns `codex`, so both headers stay byte-identical; at N=2 it returns `claude,codex`, matching the comma the header already uses for its other multi-value field (`blockingFindingIds`).

#### 1.2 Slot models: late-bound at N=1, pinned at N>1

`resolveModel` is untouched: its signature and its `explicit → env → null` precedence are exactly today's (`lib/workflow.mjs:189-197`), and changing model resolution is a non-goal. **Run time is untouched too.** `buildRuntime` calls `resolveModel` once per slot, and at N=1 that call is today's `resolveModel(task.reviewer, task.reviewerModel ?? null)` (`cli.mjs:80-84`) verbatim:

```js
reviewers: reviewerSlots(task).map((slot) => providerFor(slot.provider, {
  repoRoot,
  model: resolveModel(slot.provider, slot.model),
  budget: slot.provider === 'claude' ? slot.claudeMaxBudgetUsd : null,
  effort: resolveEffort(slot.provider, slot.effort)
}))
```

What differs by roster size is only what `initializeTask` **writes**:

```js
if (!options.reviewers?.length) throw new Error('a task needs at least one reviewer slot');
const multi = options.reviewers.length > 1;
const reviewers = options.reviewers.map((slot, index) => ({
  provider: slot.provider,
  // N=1: store the raw flag, exactly as today's `reviewerModel`. A stored null
  //      means "resolve from the environment at run time" — today's behavior,
  //      and part of the N=1 contract.
  // N>1: resolve now (flag -> env) and pin, so the audit record names every juror.
  model: multi ? pinnedModel(slot, index) : slot.model ?? null,
  effort: resolveEffort(slot.provider, slot.effort ?? null),
  claudeMaxBudgetUsd: slot.claudeMaxBudgetUsd ?? null
}));

function pinnedModel(slot, index) {
  const model = resolveModel(slot.provider, slot.model ?? null);   // explicit flag → env var → null
  if (model) return model;
  throw new Error(`reviewer slot R${index + 1} (${slot.provider}) has no model; a multi-reviewer roster `
    + `must pin every slot with --reviewer-model or ${PROVIDER_MODELS[slot.provider].env}`);
}
```

`options.reviewers` is **always non-empty** in practice — §1.3 makes the CLI synthesize a default `codex` slot when no `--reviewer` is given, which is today's behavior — so the guard above is a programming-error check, not a user-facing path. It exists because an empty array would otherwise be written to `task.json` as a roster that `reviewerSlots` refuses and `loadContext` rejects one command later, far from the cause.

**The run-time path needs no conditional, and that is the design rather than a coincidence.** `resolveModel`'s first step is `model ?? env[spec.env]` (`lib/workflow.mjs:195`), so a pinned non-null model short-circuits the environment lookup and a stored `null` falls through to it. "Frozen at N>1" and "late-bound at N=1" are the *same line*, selected by the stored value — no branch to drift, no run-time validation to add, and nothing for `status` to trip over. Resolution must happen in `initializeTask`, not in `cli.mjs`, so that every caller — including tests — gets the same roster.

**N=1 is behaviorally today's in every combination**, which is the point:

| creation | stored `reviewers[0].model` | run and resume |
|---|---|---|
| `--reviewer-model gpt-5.6` (with or without an explicit `--reviewer`) | `'gpt-5.6'` | pinned — today stores the raw flag too |
| `PLAN_FORGE_CODEX_MODEL` set, no flag | `null` | env read on **every** run: changing it between rounds changes the model, as today |
| neither | `null` | provider CLI default, as today |

The roster deliberately does **not** pin at N=1. The frozen requirement's own evidence is that the model decides between "zero findings, approved" and two majors; a task created while `PLAN_FORGE_CODEX_MODEL` happened to be exported would, under creation-time pinning, keep that model for its whole life while today's tool follows the environment. That is a different plan, different findings, and a different verdict from the same commands and the same environment — precisely what the N=1 behavioral contract forbids. Tasks already on disk carry the legacy shape and are unaffected either way.

**Why N>1 pins.** The codex adapter records `meta.model` from the configured value (`lib/providers/codex.mjs:70`), so a slot that resolves to null persists `model: null` in the audit record. `null` there does not mean "the default" — it means *whatever that provider CLI happened to default to on the day the round ran*, which is unknowable afterward. The Background is exactly a story about an unnoticed default (gpt-5-mini, reached because the codex adapter passes `--ignore-user-config`) silently deciding a review's outcome. A deliberately assembled jury whose audit record cannot say who served defeats AC5 in the very configuration this feature exists for. Two consequences worth stating:

- **An env-provided model is a valid pin.** It resolves to a real name that reaches both the adapter and `meta.model`, so `PLAN_FORGE_CODEX_MODEL=gpt-5.6` with no flag pins a slot. What is rejected is a slot that resolves to *nothing*.
- **Pinning also keeps a multi-slot jury stable across rounds**, and it is what lets §7.1 check a committed capture's model against the slot that was supposed to produce it. Those are properties N=1 never promised and does not acquire here; they are bought for N>1 only, where there is no prior behavior to preserve.

Note the requirement is *pinned*, not *distinct*: two slots pinned to the same model are a legitimate sampling-variance probe (§1.3), and they remain traceable because slot id, not model, is the identity.

This is not a new idea in this file. `initializeTask` **already resolves effort at creation** and stores the resolved value (`lib/workflow.mjs:542-543`), and effort stays mutable because `updateTaskSettings` exists to change it on resume (§8). The author's model resolution is deliberately left alone: it is not part of the roster, and the non-goal forbids touching model resolution beyond what the roster forces.

#### 1.3 CLI

```text
--reviewer <claude|codex>                    # repeatable; omitted → one codex slot
--reviewer-model <model>                     # slot-scoped
--reviewer-effort <effort>                   # slot-scoped
--claude-reviewer-max-budget-usd <amount>    # slot-scoped
--reviewer-timeout <seconds>                 # round-level
```

`parseArgs` gains an ordered token list beside the existing last-wins map: `{ command, values, tokens }`, where `tokens` is `[[key, value], …]` in argv order. **Every existing option keeps reading `values`**, so nothing else changes.

**The binding rule, stated once for all three cases:**

> **Fewer than two `--reviewer` occurrences → the roster is exactly one slot, and every slot-scoped flag binds to it from `values`, regardless of order. Two or more → binding is positional: each slot-scoped flag binds to the most recent preceding `--reviewer`, read from `tokens`.**

- **Zero `--reviewer`** → one **`codex`** slot. This is today's default and it must not move: `cli.mjs:92` is `const reviewer = values.reviewer || 'codex'`, and `cli.mjs:103` reads `values['reviewer-model']` with no reference to `values.reviewer` at all. So `plan-forge run --task t --requirement r.md` and `plan-forge run --task t --requirement r.md --reviewer-model gpt-5.6` are both working commands today, and both keep working, unchanged, producing a one-slot `codex` roster. The earlier draft of this section defined binding only for one or many explicit `--reviewer`s, which would have left the zero case building an empty roster — an invalid `task.json`, or a rejection of the most common invocation there is.
- **Exactly one `--reviewer`** → slot-scoped flags bind to it regardless of order. `--reviewer-model x --reviewer codex` must keep working for existing scripts.
- **More than one `--reviewer`** → most-recent-preceding binding. A slot-scoped flag before the first `--reviewer` is an error: `--reviewer-model must follow the --reviewer it configures when several reviewers are given`.

The one-slot branch is literally today's code — read the flags out of `values` and ignore order — so no existing command can change meaning. `tokens` is consulted only when a second `--reviewer` appears, which no command in existence does.

A delimited mini-language (`--reviewers 'codex:gpt-5.6,claude:opus'`) was rejected: it needs its own escaping rules and cannot carry per-slot effort and budget without becoming unreadable.

**`lib/roster.mjs`** — new, pure, no I/O: `reviewerRosterFromArgs({ author, tokens, values })` returns the slot array that becomes `options.reviewers`. It lifts today's reviewer half of `taskOptions` (`cli.mjs:92-98`, `:103`, `:105`, `:113-114`) whole, preserving both error strings verbatim:

- a slot provider outside `claude|codex` → `--author and --reviewer must be claude or codex` (today's message at `cli.mjs:93-95`, which covers both roles in one string);
- **`--allow-same-provider` keeps its current meaning** — it guards **author vs. reviewer**, so it is now required iff **any** slot's provider equals the author's → `author and reviewer must differ unless --allow-same-provider is set` (`cli.mjs:96-98`). Two reviewer slots sharing a provider need no flag: that is the intended configuration, and even the same model twice is a legitimate sampling-variance probe.

`taskOptions` keeps author defaulting and every non-reviewer option, and calls `reviewerRosterFromArgs` for `options.reviewers`.

Why a module rather than a function inside `cli.mjs`: `cli.mjs` calls `main()` at import time (`cli.mjs:243`), so nothing in it is importable from a test without first guarding the entrypoint — and the obvious guard, `process.argv[1] === fileURLToPath(import.meta.url)`, is wrong for an npm-installed bin, where `argv[1]` is the `.bin` symlink and `import.meta.url` is the resolved realpath. That guard would silently turn the published CLI into a no-op. A pure module makes the binding rule directly testable (test 30) without touching how the CLI starts.

### 2. Artifact layout

```text
rounds/003/
├── author-output.json      # unchanged (authoritative author source, stored verbatim)
├── plan.md                 # unchanged (projection)
├── resolution.json         # unchanged (projection)
├── reviews/
│   ├── R1.json             # NEW: slot capture, authoritative, one atomic rename each
│   └── R2.json
├── review.json             # the MERGED round review — same path and shape as today
└── manifest.json           # audit summary
```

The single most important compatibility decision: **`review.json` keeps its path and its shape, and becomes the merged round review.** Today's `review.json` — orchestrator-allocated IDs, a self-checked verdict, `{meta, review:{verdict, previousFindings, newFindings, summary}}` — *is already* the merged document for a one-slot round. So:

- `collectFindings` / `applyReviewToMap` in `lib/findings.mjs` need **no changes at all**. They fold merged documents, which is what they already do.
- A legacy `rounds/NNN/review.json` is read as that round's merged document directly. **No migration, no rewrite, no dual read path** for the merged doc.
- `approval.json` keeps its exact key set, `reviewSha256` still being `fileSha256(review.json)`. An already-approved legacy task revalidates unchanged.
- The existing tests that read `rounds/00N/review.json` and assert on `.review.verdict`, `.review.previousFindings[].id`, `.review.newFindings[0].id` (`test/workflow.test.mjs:145,324,329`) keep passing untouched.

**Per-slot capture** `reviews/R2.json`:

```json
{
  "meta": { "schemaVersion": 1, "role": "reviewer", "round": 3, "slot": "R2",
            "provider": "codex", "model": "gpt-5.6", "cliVersion": "...", "promptSha256": "...",
            "effort": "high", "startedAt": "...", "completedAt": "...", "usage": {},
            "costUsd": null, "sessionId": "...", "gitHead": "...", "gitDirty": false,
            "planSha256": "..." },
  "review": { "verdict": "changes_requested", "previousFindings": [...],
              "newFindings": [ { "id": null, ... } ], "summary": "..." }
}
```

`wrapperMeta` already supports `extra`; pass `{ planSha256, slot: slot.id }`. New findings keep **`id: null`** — IDs are not allocated at capture (§4.1). A `relatedToFindingId` in a capture is one of two things: an `F`-id, naming a finding from a **prior round**; or a `P<k>`, naming **this capture's own k-th new finding** (§4.1.1). The unchanged reviewer-output schema types the field `["string","null"]` (`schemas/reviewer-output.schema.json:43-45`), so both forms validate against it. `meta.promptSha256` is what `wrapperMeta` already computes from the prompt it was given, and it is load-bearing twice over: it is the round's input fingerprint (§7.3) and the mechanical statement of prompt independence (§6). `meta.provider` and `meta.model` come from the adapter that actually ran, which is what makes them worth checking against the slot's frozen configuration (§7.1).

**Merged** `review.json`:

```json
{
  "meta": { "schemaVersion": 2, "role": "reviewer", "round": 3,
            "planSha256": "...", "promptSha256": "...",
            "startedAt": "...", "completedAt": "...",
            "gitHead": "...", "gitDirty": false,
            "reviewers": [ { "slot": "R1", "provider": "claude", "model": "opus-4.8",
                             "cliVersion": "...", "effort": "high",
                             "startedAt": "...", "completedAt": "...",
                             "usage": {}, "costUsd": null, "sessionId": "...",
                             "captureSha256": "..." } ] },
  "review": {
    "verdict": "changes_requested",
    "summary": "...",
    "summaries": [ { "slot": "R1", "summary": "..." } ],
    "previousFindings": [ { "id": "F001", "status": "still_open", "effectiveSeverity": null,
                            "explanation": "…",
                            "arbitration": { "winner": "R2", "dispositions": [
                              { "slot": "R1", "status": "resolved", "effectiveSeverity": null, "explanation": "…" },
                              { "slot": "R2", "status": "still_open", "effectiveSeverity": null, "explanation": "…" } ] } } ],
    "newFindings": [ { "id": "F003", "raisedBy": "R2", "sourceIndex": 0, "severity": "major", "...": "..." } ]
  }
}
```

**`meta` splits by scope, and every round-level field keeps its name and its meaning.** This is what makes the merged document a drop-in for today's:

- `round`, `planSha256`, `gitHead`, `gitDirty` — round-level, unchanged.
- `promptSha256` — the round's single reviewer prompt. Equal to every slot's `meta.promptSha256` by construction, because a capture with any other value is not part of this round (§7.3). At N=1 it is today's value.
- `startedAt` — the earliest slot start, so a round's wall-clock span is still readable from one artifact. At N=1 it is today's value.
- `completedAt` — **the instant the merge committed.** This is the round's canonical completion timestamp and the reason there is no `mergedAt`: a second name for the same instant would be one more thing to keep in sync, and `completedAt` already means "when this round's review was completed" and is the field every consumer already reads. `publishForHuman`'s `stoppedAt=${review.meta.completedAt}` (`lib/workflow.mjs:170`) therefore needs **no change and no legacy fallback**, and its documented no-churn property (`lib/workflow.mjs:167-168` — "stoppedAt tracks the verdict, not the moment of writing") is preserved exactly, because the merged artifact is frozen and the value is stable across every later load. At N=1 the value is the merge instant rather than the slot's completion instant, milliseconds apart; it is the same quantity, measured at the point the round actually finished.
- `reviewers[]` — the per-slot fields (`provider`, `model`, `cliVersion`, `effort`, `usage`, `costUsd`, `sessionId`), plus `captureSha256`, the sha256 of that slot's committed capture file. It is named `captureSha256`, not `reviewSha256`, because `manifest.reviewSha256` and `approval.reviewSha256` already mean "sha256 of the merged `review.json`"; one name for two different files at two nesting levels is a trap. `meta.reviewers` is also the round's own manifest of which slots served, which is what §7.1 verifies against.

At N=1 every added key in `review` is either a single-element wrapper around today's value or absent-equivalent: `arbitration.dispositions` has one entry whose values *are* the hoisted top-level ones; `raisedBy` is `"R1"`. The top-level `verdict`, `previousFindings[].{id,status,effectiveSeverity,explanation}`, and `newFindings[].{id,relatedToFindingId,…}` are byte-for-byte what today's normalizer writes.

`review.summary` is `summaries.length === 1 ? summaries[0].summary : summaries.map(s => `${s.slot}: ${s.summary}`).join('\n\n')`. The ternary exists so N=1 emits today's summary verbatim; attribution lives in `summaries` unconditionally.

#### 2.1 The round declares its format; the format is never inferred

**`meta.schemaVersion` is the discriminator, and it is a positive declaration.** A merged review this code writes carries `schemaVersion: 2`. Every `review.json` already on disk carries `schemaVersion: 1`, because `wrapperMeta` has always stamped it (`lib/workflow.mjs:216`). So the two formats are told apart by a field that is **present and asserted on both sides**, never by the absence of one.

The earlier draft identified a legacy round by "`meta.reviewers` is absent," and that was wrong in a way worth naming, because it is the failure mode this whole section exists to prevent: absence-as-signal means the *weaker* branch is the default. A merged round that lost `meta.reviewers` — to a merge bug, a partial write, or an edit — would have been silently reclassified as legacy, would have read zero captures, and would have skipped every missing/hash/unknown-slot check in §7.1. The verification added to keep the audit chain honest would have been disabled by deleting one field. Under a declared version, that same artifact fails validation loudly: it says it is format 2, and format 2 requires the manifest.

`schemaVersion` is **per file format, not global**. `review.json` has two formats on disk, so merged rounds move to 2. `reviews/RN.json` has exactly one format that will ever exist, so captures stay at `schemaVersion: 1` — it is the first version of a new file, not the second version of an old one. `task.json`, `state.json`, `approval.json`, `manifest.json`, and the overrides document are all untouched at 1.

Bumping the merged review's version is behaviorally free, which is why it is available as a discriminator at all: **no code anywhere reads a review wrapper's `schemaVersion`.** The only version check in the tree is `task.schemaVersion !== 1` (`lib/workflow.mjs:347`), on a different file; `writeManifest` copies `review.meta` into `manifest.reviewerMeta` without inspecting it (`lib/workflow.mjs:447`), and `approval.json` pins `review.json` by whole-file sha, not by field. The field has been carried, written, and never consulted — this change gives it the job it was named for.

**Schema validation splits by audience and by format, and this is load-bearing:**

- `schemas/reviewer-output.schema.json` — **unchanged file**. It validates each slot's raw model output, and it also validates the `review` body of a **v1** `review.json` on the legacy load branch — the same call today's loader makes, on the same bytes (`lib/workflow.mjs:334`). Because it never gains a `raisedBy` or `arbitration` field, the provider-common subset (`additionalProperties: false`, every property required) stays intact and the reviewer's wire contract is byte-identical to today's.
- `schemas/merged-review.schema.json` — **new**, orchestrator-internal, compiled in `loadSchemas` as `validateMergedReview`. It applies to **v2 rounds only** and validates the **entire wrapper**, `meta` included — not just `review`, which is all today's loader checks. No model ever sees it, so it is not provider-common and may use `const`, `pattern`, and `minItems`; `test/schema.test.mjs:15` walks only `authorSchema` and `reviewerSchema`, so the subset test is unaffected.

Because the merged schema never has to accept a legacy artifact, **provenance is required, not optional** — the inversion that closes the hole:

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["meta", "review"],
  "properties": {
    "meta": {
      "type": "object",
      "additionalProperties": false,
      "required": ["schemaVersion", "role", "round", "planSha256", "promptSha256",
                   "startedAt", "completedAt", "gitHead", "gitDirty", "reviewers"],
      "properties": {
        "schemaVersion": { "const": 2 },
        "role": { "const": "reviewer" },
        "round": { "type": "integer", "minimum": 1 },
        "planSha256": { "type": "string", "pattern": "^[0-9a-f]{64}$" },
        "promptSha256": { "type": "string", "pattern": "^[0-9a-f]{64}$" },
        "reviewers": {
          "type": "array", "minItems": 1,
          "items": {
            "type": "object", "additionalProperties": false,
            "required": ["slot", "provider", "model", "cliVersion", "effort", "startedAt",
                         "completedAt", "usage", "costUsd", "sessionId", "captureSha256"],
            "properties": {
              "slot": { "type": "string", "pattern": "^R[1-9][0-9]*$" },
              "provider": { "enum": ["claude", "codex"] },
              "captureSha256": { "type": "string", "pattern": "^[0-9a-f]{64}$" }
            }
          }
        }
      }
    },
    "review": {
      "type": "object", "additionalProperties": false,
      "required": ["verdict", "summary", "summaries", "previousFindings", "newFindings"],
      "properties": {
        "previousFindings": { "items": { "required": ["id", "status", "effectiveSeverity",
                                                      "explanation", "arbitration"] } },
        "newFindings": { "items": { "required": ["id", "raisedBy", "sourceIndex", "…"] } }
      }
    }
  }
}
```

`newFindings[].id` is `pattern: "^F[0-9]{3,}$"` (never null in a merged doc) and `raisedBy` is `^R[1-9][0-9]*$`; `arbitration` requires `winner` plus a `dispositions` array of `minItems: 1`.

Two consequences fall out, and they are the point:

- **A v2 round cannot shed its provenance.** Dropping `meta.reviewers`, or `raisedBy` from one finding, or `arbitration` from one previous finding, is a schema failure naming the field — not a quiet demotion to a branch with no checks.
- **A v2 round cannot forge its way onto the legacy branch either.** Setting `schemaVersion` to `1` while keeping the merged shape fails the v1 branch: `meta.reviewers` trips §7.1's explicit check, and `raisedBy` / `sourceIndex` / `arbitration` / `summaries` are additional properties under the unchanged `additionalProperties: false` reviewer schema. Reaching the legacy branch requires stripping every provenance field from every finding — a wholesale rewrite of `review.json`, which is the honest bound here: nothing defends an unapproved round against a full rewrite of its own bytes today either, and an approved one is pinned by `approval.reviewSha256`. What is closed is the accidental and single-field cases, which are the ones that actually happen.

The merged schema restates the finding-body fields rather than `$ref`-ing the reviewer schema, which has no `$id` and is provider-facing (adding one to serve an internal schema would put orchestrator plumbing in a file models read). Test 34 is the drift guard: it asserts mechanically that every key the reviewer schema requires of a finding is also required by the merged schema, so the two cannot silently diverge.

`loadRoundArtifacts` dispatches on the declared version (§7.1) and uses `schemas.validateReviewer` on each `reviews/*.json`.

### 3. The reviewing phase

```js
const author = context.authorOutputs.get(currentRound);
if (!context.reviews.some((item) => item.meta.round === currentRound)) {
  const roster = reviewerSlots(context.task);
  // One prompt per round, built before any slot decision: it is both what every
  // slot is asked and the fingerprint of what this round is asking (§7.3).
  const prompt = buildReviewerPrompt({ /* §6 — one prompt, shared by every slot */ });
  const promptSha256 = sha256(prompt);
  const committed = context.slotReviews.get(currentRound) ?? new Map();
  const fresh = new Map();
  for (const slot of roster) {
    const entry = committed.get(slot.id);
    if (!entry) continue;
    if (entry.wrapper.meta.promptSha256 === promptSha256) { fresh.set(slot.id, entry); continue; }
    logger.stage('reviewer capture superseded; the round inputs changed', {
      phase: 'reviewing', round: currentRound, slot: slot.id,
      capturedPromptSha256: entry.wrapper.meta.promptSha256, promptSha256
    });
  }
  const pending = roster.filter((slot) => !fresh.has(slot.id));

  if (pending.length) {
    for (const slot of pending) {
      const prior = await failureStatus(context, phaseKeyOf('reviewing', currentRound), slot.id);
      if (prior.status === 'needs_human') {
        logger.stage('provider failure limit reached', { phase: 'reviewing', round: currentRound, slot: slot.id });
        return writeState(context, {
          status: 'needs_human', phase: 'reviewing', round: currentRound, errorClass: 'provider_failure_limit'
        });
      }
    }
    const settled = await Promise.allSettled(
      pending.map((slot) => runReviewerSlot({ context, slot, prompt, author, round: currentRound, logger }))
    );
    const failures = settled.flatMap((outcome, i) =>
      outcome.status === 'rejected' ? [{ slot: pending[i], error: outcome.reason }] : []);
    if (failures.length) return handleReviewFailures(context, { round: currentRound, failures, logger });
    continue;   // reload; the next iteration finds the barrier reached and merges
  }

  const merged = mergeRoundReviews({
    round: currentRound, roster, slotReviews: fresh, promptSha256,
    priorReviews: context.reviews, overrides: context.overrides, planSha256: sha256(author.plan)
  });
  await atomicWriteJson(files.review, merged);
  logger.stage('round reviews merged', {
    phase: 'reviewing', round: currentRound, file: files.review,
    reviewers: roster.length, verdict: merged.review.verdict
  });
  context = await loadContext({ repoRoot, taskId, schemas, repair: true });
  await writeManifest(context, currentRound, logger);
  continue;
}
```

`runReviewerSlot` invokes through the existing `invokeWithLimit` (so per-slot transient retry is unchanged), normalizes with `normalizeSlotReview` (§4.1), and commits `reviews/<slot>.json` by one atomic rename. `readSlotReviews` returns `Map<slotId, { wrapper, fileSha256 }>`, so the merge can record `captureSha256` without doing I/O of its own and stays a pure function (§4). `mergeRoundReviews` stamps `meta.schemaVersion: 2` (§2.1); the merged document it returns is reloaded through `loadContext` immediately after the write, so the v2 branch's full-wrapper validation and capture verification run over the bytes just committed — the merge cannot write an artifact its own loader would reject.

Four properties fall out of this shape:

- **`Promise.allSettled`, not `Promise.all`.** `Promise.all` rejects on the first failure while peers keep running, and their commits would then race the failure handler. The barrier requires waiting for *every* reviewer to return before deciding anything.
- **Fan-out and merge are separate loop iterations.** The merge always reads *committed artifacts*, never in-memory results. So the merge path is identical on a fresh run and on a resume — there is one code path and every run exercises it. A crash immediately after the last slot commits resumes straight into the merge branch.
- **The barrier is `pending.length === 0`**, derived from the artifact graph. It survives process death for free, exactly like every other recovery decision in `docs/design.md` §3.
- **The freshness filter runs on every iteration, including the merging one.** That is not redundant: `loadContext` re-reads the overrides document at the top of each iteration, so a human override landing during the fan-out is seen by the merge iteration, which then finds every capture stale and fans out again rather than merging answers to a question that has changed. The merge's precondition — all N captures share one `promptSha256` — is therefore established by the same filter that selects them, with no separate assertion to drift.

#### 3.1 The adapter preflight

`buildRuntime` builds `providers.reviewers` as an array **parallel to `reviewerSlots(task)`**; `runReviewerSlot` indexes it by `slot.index - 1`. The `providers.reviewer` singular key is replaced by `providers.reviewers`. A positional array is the right shape — slot identity *is* position — but position is only meaningful if the array actually lines up, so `runWorkflow` checks it before spending anything:

```js
// runWorkflow, immediately after each loadContext, before any provider call.
assertReviewerAdapters(reviewerSlots(context.task), providers.reviewers);

function assertReviewerAdapters(roster, adapters) {
  if (!Array.isArray(adapters) || adapters.length !== roster.length) {
    throw new Error(`${Array.isArray(adapters) ? adapters.length : 0} reviewer adapters were supplied `
      + `for a ${roster.length}-slot roster`);
  }
  for (const slot of roster) {
    const adapter = adapters[slot.index - 1];
    if (adapter.name !== slot.provider) {
      throw new Error(`reviewer slot ${slot.id} is configured for ${slot.provider} `
        + `but the runtime supplied a ${adapter.name} adapter`);
    }
  }
}
```

`buildRuntime` maps the roster directly, so it agrees by construction — but **it is not the only composition path**. `runWorkflow` is exported and takes `providers` from its caller: every test in `test/workflow.test.mjs` builds it by hand (`:29`), as does `test/live.test.mjs:31-34`, and a future caller may too. Without the check, a mis-ordered or short array fails silently in the worst way: R1 invokes a claude adapter, spends real money, and commits `reviews/R1.json` recording `meta.provider: 'claude'` against a slot `task.json` says is `codex` — an audit record naming the wrong juror, which is AC5's failure mode exactly, and a short array throws an opaque `Cannot read properties of undefined` from inside the fan-out after the author has already run. Both adapters expose a stable `name` (`lib/providers/claude.mjs:14`, `lib/providers/codex.mjs:22`), so the check is a length test and one comparison per slot.

It runs inside the loop rather than once before it because the roster is frozen (§1.1), which makes the check idempotent and free over in-memory data — and running it on every iteration means no resume path can skip it. Placing it right after `loadContext` means a mismatched runtime costs zero provider calls, including the author's. Adapters do not expose the model they were constructed with, so the preflight covers provider identity only; model agreement is checked where the model is actually observable — in the capture (§7.1).

**Logging.** The slot goes in the log *fields*, never in the stderr prefix: `logger.providerStderr(provider.name, chunk, { phase, round, attempt, slot: slot.id })`. The documented `codex:stderr` / `claude:stderr` prefix (`docs/design.md:84`) is therefore unchanged, and the slot shows up as `slot="R2"` in the field text. Stage and error lines in the reviewing phase gain the same field.

### 4. The merge — `lib/merge.mjs`

New module. `lib/findings.mjs` keeps ownership of finding-state folding; the merge (allocation, arbitration, verdict composition) is a distinct concern and gets its own file. `mergeRoundReviews` does no I/O: everything it needs, including each capture's `fileSha256`, is passed in, which is what keeps `test/merge.test.mjs` a pure unit suite.

#### 4.1 ID allocation (AC2)

**The concrete race being fixed:** today `normalizeReviewerOutput` allocates IDs at capture time from `nextFindingNumber(before)` (`lib/findings.mjs:168`). Two concurrent slots would both read `3` and both mint `F003`; `applyReviewToMap` would then throw `duplicate finding id F003` (`lib/findings.mjs:39`) and the round would be unrecoverable.

The fix is structural, not a lock: **capture never allocates.** `normalizeReviewerOutput` splits:

- `normalizeSlotReview(output, { round, priorReviews, overrides })` — computes `before = collectFindings(priorReviews, overrides)` exactly as today (`lib/findings.mjs:137`), validates disposition completeness against `activeFindings(before)`, resolves each `relatedToFindingId` (§4.1.1), coerces redundant `effectiveSeverity` echoes, checks the slot's own verdict (§4.3), and returns `{ normalized, coercions }` with `newFindings[].id` still `null`.
- `mergeRoundReviews(...)` in `lib/merge.mjs` allocates, arbitrates, and composes.

Allocation walks the roster in **slot order**, and within a slot preserves the reviewer's own `newFindings` array order:

```js
const before = collectFindings(priorReviews, overrides);
let next = nextFindingNumber(before);
const newFindings = [];
for (const slot of roster) {
  const captured = slotReviews.get(slot.id).wrapper.review.newFindings;
  const ids = captured.map(() => `F${String(next++).padStart(3, '0')}`);   // this slot's ids, in array order
  captured.forEach((finding, sourceIndex) => {
    const selfRef = /^P(\d+)$/.exec(finding.relatedToFindingId ?? '');
    newFindings.push({
      ...finding,
      id: ids[sourceIndex],
      // A prior-round reference passes through untouched; a slot-local one
      // resolves against this slot's own allocation, never a peer's (§4.1.1).
      relatedToFindingId: selfRef ? ids[Number(selfRef[1]) - 1] : finding.relatedToFindingId,
      raisedBy: slot.id,
      sourceIndex
    });
  });
}
```

- **Race-free by construction**: allocation happens in exactly one place, single-threaded, after the barrier. No concurrent allocator exists, so there is no lock to get wrong.
- **Deterministic**: depends only on (prior state, roster order, each slot's array order). Slot R2 finishing first does not shift a single ID.
- **Stable**: allocated once, persisted in `review.json`, never recomputed (§7.2).
- **Override-independent**: `nextFindingNumber` reads `findings.keys()`, and an override never adds or removes a key — it only closes or re-severities. So AC2's determinism survives any override history.

`raisedBy` is set on every merged new finding here, unconditionally, which is what lets the v2 schema require it (§2.1) rather than tolerate its absence.

#### 4.1.1 Same-output relations, and why the reference resolution is slot-local

**The N=1 behavior that must survive.** Today's normalizer does `knownIds.add(id)` as it allocates each ID (`lib/findings.mjs:187`), so a later new finding **in the same output** may name an earlier one. That line is deliberate — it exists for no other purpose. The fold honors it too: `applyReviewToMap` walks `newFindings` in array order and `map.set`s each one (`lib/findings.mjs:37-56`), so a same-output `recurrence` finds its ancestor already in the map and inherits its streak (`lib/findings.mjs:44,53`). And it is reachable, not theoretical: allocation is exactly `F(base + k)` for `base = nextFindingNumber(before)`, which a reviewer that can count the findings it was handed can predict — the reviewer prompt tells it to relate new findings to earlier ones (`prompts/reviewer.md:43-48`) without restricting that to prior rounds. Accepted today means it is in the N=1 contract. Rejecting it would throw `new finding relates to unknown id F003` from inside `invokeWithLimit`'s validator, which burns a retry and can drive a task to `needs_human` on output the tool accepts today.

**The trap in the other direction, which is worse.** That prediction is only correct at N=1. At N=2, R2's first new finding is allocated *after* all of R1's, so R2 writing `F003` means "my own first finding" while `F003` actually belongs to R1. A merge that validated references against "prior IDs ∪ everything allocated so far" would resolve R2's self-reference to **a peer's finding** — silently, and a `recurrence` would then inherit a stranger's streak and push an unrelated finding toward a human handoff. Rejecting the reference loses a real behavior; mis-binding it corrupts the audit chain. Both are avoided by making the resolution **slot-local**.

> **Rule: a new finding's `relatedToFindingId` names either a finding in `before` (a prior round), or one of *this slot's own earlier* new findings, addressed by its position-predicted id `F(base + k)`. Nothing else. Capture rewrites the second case to a slot-local provisional id; the merge rewrites that to the real one.**

```js
const before = collectFindings(priorReviews, overrides);
const base = nextFindingNumber(before);
const knownIds = new Set(before.keys());
// The k-th new finding is predicted F(base + k) — precisely what today's
// allocator assigns it, and what a counting reviewer can name.
const predicted = new Map(output.newFindings.map((_, k) => [`F${String(base + k).padStart(3, '0')}`, k]));

const newFindings = output.newFindings.map((finding, k) => {
  if (finding.id !== null) throw new Error('provider-created new finding id must be null');
  let relatedToFindingId = finding.relatedToFindingId;
  if (relatedToFindingId === null) {
    if (finding.relationKind !== null) throw new Error('new finding without relatedToFindingId must set relationKind null');
  } else {
    const selfIndex = predicted.get(relatedToFindingId);
    if (knownIds.has(relatedToFindingId)) {
      // prior-round reference: passes through verbatim, as today
    } else if (selfIndex !== undefined && selfIndex < k) {
      relatedToFindingId = `P${selfIndex + 1}`;   // resolved to a real id at merge time
    } else {
      // forward references, out-of-range predictions, and junk alike —
      // today's rejection, today's message
      throw new Error(`new finding relates to unknown id ${finding.relatedToFindingId}`);
    }
    if (!RELATION_KINDS.has(finding.relationKind)) {
      throw new Error(`new finding related to ${finding.relatedToFindingId} needs relationKind "recurrence" or "adjacent"`);
    }
  }
  /* … noveltyRationale / problem / requiredChange checks, unchanged … */
  return { ...finding, id: null, relatedToFindingId };
});
```

**This is exactly today's acceptance set at N=1, not an approximation of it.** Today's `knownIds` when validating index `k` is `before.keys() ∪ {F(base), …, F(base+k-1)}` — which is case (a) ∪ case (b), the two branches above. The cases are disjoint because `base` is one past the highest existing number, so a predicted id can never collide with a prior-round id. Forward references (`selfIndex >= k`), predictions past the end of the array, and non-id junk all still throw, with today's message and today's check order (unknown-id before relationKind). `test/findings.test.mjs:181-183` passes unchanged.

**Why `P`, and why rewrite at capture:**

- The provisional namespace is the one §4.3's verdict self-check already uses — the finding at source index `k` is `P{k+1}` there — so a rewritten reference resolves inside the self-check's synthetic map with no extra machinery, and the streak it computes matches today's. P-ids appear only inside a capture and only in `relatedToFindingId`; every allocated finding id is `F%03d`, so the two namespaces cannot collide, and the v2 schema's `^F[0-9]{3,}$` on merged ids makes a leaked P-id a validation failure rather than a silent dangling reference.
- A predicted id is only interpretable against the `base` in force when the slot was **asked**. Resolving it once, at capture, means the merge never re-interprets an id against a base that may have moved. §7.3's fingerprint rule does in fact pin `before` (the prompt names every prior finding, so it fixes `nextFindingNumber`), but leaning on that would make a subtle invariant load-bearing for the correctness of an id rewrite. Index-based resolution needs no such argument.
- `sourceIndex`, already on every merged new finding for traceability, is what makes a `P<k>` auditable after the fact: it records the position the provisional id refers to.

**Fold order still holds.** A slot-local reference always points backwards (`selfIndex < k`), and the merge emits each slot's findings in array order, so an ancestor is always folded before its referent — the same guarantee `applyReviewToMap` relies on today. A prior-round reference resolves against a map already populated by earlier rounds.

Cross-slot references remain unrepresentable, which was the original observation and is still true: a reviewer never sees a peer's findings, and their ids are null. §4.1.1 is what stops that from being *accidentally* violated by a coincidence of counting.

#### 4.2 Arbitration — Q1 / AC3

Every slot dispositions every active finding (guaranteed by the per-slot completeness check, and by the §7.3 rule that every capture in the round answered the same active set), so each active finding arrives at the merge with exactly N dispositions.

> **Rule: a finding stays open at the highest severity any reviewer assigns it, and closes only if every reviewer closes it. Ties go to the lowest slot index.**

```js
const SEVERITY_RANK = { blocker: 4, major: 3, minor: 2, nit: 1 };

function outcomeRank(disposition, finding) {
  if (CLOSED.has(disposition.status)) return 0;                      // resolved | withdrawn
  return SEVERITY_RANK[disposition.status === 'severity_changed'
    ? disposition.effectiveSeverity
    : finding.effectiveSeverity];
}

function arbitrate(finding, dispositions) {   // dispositions in roster order
  return dispositions.reduce((winner, candidate) =>
    outcomeRank(candidate, finding) > outcomeRank(winner, finding) ? candidate : winner);
}
```

Strict `>` over a roster-ordered list is what makes the tie-break "lowest slot index" without a second comparator. The winner's `status` / `effectiveSeverity` / `explanation` are hoisted to the merged entry; **all N dispositions are recorded** under `arbitration.dispositions`, so no reviewer's position is ever discarded — and the v2 schema requires the `arbitration` block on every previous finding, so a merge that dropped one could not be committed and reloaded.

Why most-open-wins, and not majority, first-to-return, or most-recent:

1. **It is the same operation as the union, applied to the other side of the ledger.** New findings are unioned — the merged set is what *any* reviewer found. Dispositions are the dual: a finding closes only when *no* reviewer still sees it. Any other rule lets a plan close a defect a reviewer is, right now, on the record as still seeing — which makes the merged jury **weaker than its strictest member**, the exact inversion of why this feature exists.
2. **The costs are asymmetric.** Wrongly holding a finding open costs one revision round, and the author can close it with `rejected` plus evidence, a reviewer can `withdraw` it next round, and a human can override it. Wrongly closing one ships a defective plan through the gate — silently, which is the single outcome the gate exists to prevent. The cheap error is recoverable; the expensive one is not.
3. **The project's own evidence disproves majority voting.** At N=2 — the configuration the Background is about — there is no majority. At N=3 it would have let gpt-5-mini's "zero findings, approved" help cancel a real major from Claude. The Background *is* a case where one reviewer's silence was wrong; a rule that lets silence outvote a finding is refuted by the data this change is built on.
4. **It cannot deadlock, because the escape hatches already exist.** A reviewer stubbornly holding a wrong finding open drives `criticalReviewStreak` to 2 → `needs_human` → the human rules `withdrawn`. That path is already built, tested, and documented (`docs/design.md` §7). The rule routes disputes into it rather than inventing a second adjudicator.

`resolved` vs. `withdrawn` when all slots close: both rank 0 and `applyReviewToMap` treats them identically (`lib/findings.mjs:18-24`), so the tie-break is audit-only; all N are recorded regardless.

Overrides are **not** part of arbitration. They apply after the fold, as the last layer, exactly as today (`collectFindings` → `applyOverrides`).

#### 4.3 Verdict composition (AC4)

Both the per-slot self-check and the merged verdict go through **`collectFindings` + `blockingFindings`** — the same functions that compute the gate today. This is deliberate: no second gate implementation exists to drift from the first.

- **Per-slot self-check** (capture time, `normalizeSlotReview`): build a synthetic review from *that slot's output only*, with **provisional IDs** (`P1`, `P2`, …) since real IDs do not exist yet. Provisional IDs are unique keys for the throwaway map and are invisible to `nextFindingNumber` (which matches `^F(\d+)$`). A slot-local `relatedToFindingId` is *already* the provisional id of the finding it names (§4.1.1), so the synthetic map resolves it and a same-output recurrence inherits its ancestor's streak exactly as today. Then `after = collectFindings([...priorReviews, synthetic], overrides)` and the expected verdict is today's expression verbatim. The verdict cannot be perturbed by the id namespace either way — `blockingFindings` filters on `effectiveSeverity` and `closed` and reads `.length`, never ids or streaks — which is what makes P-ids safe here. This keeps the existing honesty check (a model that dispositions everything `resolved` and then says `changes_requested` is contradicting itself), and it is why N=1's capture is *literally today's computation*.
- **Merged verdict** (merge time): build the merged document with real IDs and arbitrated dispositions, then `verdict = blockingFindings(collectFindings([...priorReviews, mergedDoc], overrides)).length ? 'changes_requested' : 'approved'`.

A slot's own verdict is **never** the gate. `runWorkflow`'s `review.review.verdict === 'approved'` check (`lib/workflow.mjs:573`) reads the merged document, so a slot that self-consistently approved while a peer filed a blocker cannot finalize anything. At N=1 the two computations run over the same set and agree by construction.

I deliberately did **not** replace the synthetic-`collectFindings` self-check with a direct "any open critical?" scan, though it looks equivalent. It is not: `collectFindings` applies overrides *after* the fold, so a reviewer `severity_changed`→`nit` on a finding a human had overridden to `blocker` yields `blocker` today and `nit` under a naive scan. Reusing `collectFindings` makes that class of drift unrepresentable.

### 5. Duplicate coverage — Q2 / AC7

**Answer: the author handles duplicates. The orchestrator never judges equivalence.**

Merge-time mechanical detection was rejected. `docs/design.md:870-875` already ruled on it for v1 ("v1 deliberately excludes 'semantically equivalent findings' … because neither can be judged mechanically and reliably by the orchestrator"), and the failure modes are asymmetric in the worst direction: a text-similarity heuristic (same `planSection`, similar `problem`) that wrongly merges two distinct defects sharing a section **silently deletes a real finding** — in a feature whose entire purpose is to widen coverage. A false split costs the author one extra sentence. An LLM dedup pass is a stated non-goal and buys the same false-merge risk plus a provider call and a new failure mode, with less determinism.

The author is the right place on the merits, not just by elimination:

- It is already the only role that **must** form a semantic view of the whole finding set to write the plan. Dedup is free there and is a new judgment anywhere else.
- **Nothing is deleted or hidden.** All N originals stay in the merged set with distinct IDs, each traceable to its reviewer (AC5), each independently dispositionable next round by every slot.
- The orchestrator stays mechanical: it validates **coverage**, never **equivalence**.
- The failure mode is benign and self-correcting: if the author wrongly groups two distinct defects, the reviewers see one answer addressing both and re-raise the one that was not fixed. Merge-time dedup's failure is silent and permanent.

**Mechanism.** `schemas/author-output.schema.json` gains `coversFindingIds: { type: "array", items: { type: "string" } }` on each resolution — additional finding IDs this one resolution answers. `validateAuthorResolutions` becomes:

```js
const coveredIds = (resolution) => [resolution.findingId, ...(resolution.coversFindingIds ?? [])];

export function validateAuthorResolutions(resolutions, requiredFindings) {
  const expected = new Set(requiredFindings.map((finding) => finding.id));
  const seen = new Set();
  for (const resolution of resolutions) {
    for (const id of coveredIds(resolution)) {
      if (seen.has(id)) throw new Error(`duplicate resolution for ${id}`);
      seen.add(id);
    }
    if (!resolution.explanation.trim()) throw new Error(`resolution ${resolution.findingId} needs an explanation`);
    if (resolution.action === 'superseded' && resolution.changedSections.length === 0) {
      throw new Error(`superseded resolution ${resolution.findingId} must name changed sections`);
    }
  }
  const missing = [...expected].filter((id) => !seen.has(id));
  if (missing.length) throw new Error(`author output is missing resolutions for ${missing.join(', ')}`);
}
```

AC7's "consistently" is satisfied **by construction**: one resolution is one `action` plus one `explanation` applied to every ID it covers — it is not expressible to accept F001 and reject F007 in the same resolution — and the cross-resolution duplicate check makes two resolutions contradicting each other about one finding an error. Extra IDs naming non-active findings stay tolerated, matching today's treatment of extra resolutions (`docs/design.md:597-599`).

`decisionBrief`'s `resolutions.find((item) => item.findingId === finding.id)` (`lib/workflow.mjs:107`) becomes a lookup over `coveredIds`.

#### 5.1 The schema-compatibility trap, and how it is avoided

The author schema is the provider-common subset: every property is `required` and `additionalProperties: false`, and `test/schema.test.mjs:13-30` **enforces** that by walking the schema and asserting `new Set(node.required)` equals `new Set(Object.keys(node.properties))` on every object. So `coversFindingIds` cannot be added as an optional property — it is required on the wire, and a naive addition breaks **both** validation sites:

- **Load** (`lib/workflow.mjs:320`, `schemas.validateAuthor(author.output)`): every historical author output on disk lacks the field, so every existing task fails to resume.
- **Capture** (`lib/workflow.mjs:624-627`, `validate(data)` inside `invokeWithLimit`): any provider — or fake provider — that omits the field is rejected.

The rule that fixes both at once: **`author-output.json` stores exactly what the provider returned; every reader normalizes in memory before validating.** One helper, both call sites:

```js
const normalized = normalizeAuthorOutput(data);   // copy; fills coversFindingIds: [] where absent
if (!schemas.validateAuthor(normalized)) throw validationError(label, schemas.validateAuthor);
validateAuthorResolutions(normalized.resolutions, required);
// `data` is stored verbatim, exactly as today
```

Why normalize at **capture** too, rather than making every provider and fixture emit the field: the load path must normalize regardless, because legacy outputs on disk cannot be changed. Validating raw at capture would therefore be a *second* validation path that legacy rounds never take — the exact fork this plan refuses everywhere else. Normalizing at both makes a legacy round and a fresh round indistinguishable to every reader, and the default is the safe one: `[]` means "this resolution covers only its own `findingId`", which is today's semantics exactly, so a provider that ignores the field gets today's behavior instead of a rejection. The schema still marks the field required, so real structured-output providers do emit it, and `test/schema.test.mjs`'s walk still passes.

Note the deliberate asymmetry with the merged review (§2.1), which goes the other way — new format, provenance *required*, nothing defaulted. The difference is who writes the artifact. `author-output.json` is written by a **model**, whose output the tool cannot dictate retroactively and must keep accepting; `review.json` is written by the **orchestrator**, which controls every byte, so a missing field there is a bug and must be a hard failure rather than a silent default. Defaulting is for inputs the tool does not control; strictness is for artifacts it produces itself.

`normalizeAuthorOutput` returns a copy; the stored object is never mutated. **Projections and hashes are taken from the stored bytes, normalization is in-memory only:**

- `resolution.json` is projected from `stored.resolutions`, so `repair` finds no mismatch and never rewrites a committed round's projection.
- `manifest.json`'s `resolutionSha256` is `sha256(jsonText(stored.resolutions))`, so a manifest backfilled onto a legacy round agrees with the bytes actually on disk.
- The context entry carries both: `{ wrapper, plan, resolutions: normalized.resolutions, storedResolutions: stored.resolutions, files }`. Logic reads `resolutions`; projection and hashing read `storedResolutions`.

`prompts/revise.md` gains a short section explaining `coversFindingIds`: when two findings are the same defect, answer once and list the rest; every active finding must be covered exactly once across all resolutions.

### 6. Prompt-level independence — Q3

**A reviewer is never told it is one of several.** Every slot in a round receives a **byte-identical** prompt. The enforceable invariant is byte-equality *across the slots of one round* (§7.3), not byte-equality with today: at N=1 the two coincide on the initial round, and on a revision round the prompt additionally carries the author's `coversFindingIds` — an additive field the reviewer never reads (§9).

`buildReviewerPrompt`'s inputs — requirement, plan, active findings, closed findings, author resolutions, overrides — are all round-level merged state, identical for every slot. So the prompt is constructed **once per round** and handed to all N slots, and every slot's `meta.promptSha256` is equal. That equality is a mechanical, testable statement of the independence property (§V-14) — and §7.3 turns it from a consequence into an enforced precondition of the merge.

Why not tell them:

- The Background's near-zero intersection was measured on reviewers that **did not know** about each other. Telling a reviewer it is one of three changes the thing being unioned: it invites social loafing ("someone else will catch it"), severity inflation to be heard, or self-narrowed scope. All three shrink the independent draw the union depends on.
- It would fork the prompt between N=1 and N>1 for no gain.

Corollary: the prompt says **nothing** about not reading peer artifacts. Such a line would be a *request*, not an enforcement — the exact species of claim the two prior review cycles rejected — and it would reveal the roster's existence while pointing a model at where to look. The boundary is documented in §10 instead.

**`raisedBy` goes to the author, never to a reviewer.** Two projections in `lib/prompts.mjs`:

- `sanitizedFinding` (reviewer view) — **unchanged**. No `raisedBy`. So the reviewer's finding view is byte-identical to today's, and at N>1 it carries no hint of a roster: a reviewer cannot tell its own findings from a peer's, so it can neither defer to itself nor attack a peer. It dispositions each finding on whether the defect is still in the plan, which is the only question it should be answering — and is already how it treats prior-round findings.
- `authorFinding` (author view) — `sanitizedFinding` plus `raisedBy: finding.raisedBy ?? 'R1'`. The `?? 'R1'` is what makes a **v1 (legacy)** round's findings render correctly with no rewrite; it is scoped to exactly that case, because §2.1 makes `raisedBy` required on every v2 merged finding, so a v2 round can never reach this default. The author needs the attribution to judge which findings are the same defect (§5), and AC5 requires it be traceable.

`raisedBy` reaches the finding record for free: `applyReviewToMap` does `map.set(item.id, { ...item, … })` (`lib/findings.mjs:44-55`), so the merged document's `raisedBy` lands in the finding without touching `findings.mjs`.

**The author prompt names slot IDs only — never providers or models.** `raisedBy: "R2"` and nothing more. Telling the author that R2 is `codex/gpt-5-mini` would invite it to dismiss findings by model reputation, which is a defect-suppression channel the merge exists to close. Slot IDs are opaque, distinct sources; that is all the author needs and all it gets.

### 7. Loading, freezing, and recovery

#### 7.1 `loadRoundArtifacts` reads N reviews per round

Signature gains `roster`. Per round, after the author output is loaded, the review is dispatched on the format it **declares** (§2.1):

```js
const review = await readJsonIfExists(files.review);
if (review) {
  const version = review.meta?.schemaVersion;
  if (version === 2) {
    // Whole wrapper, meta included: provenance is required, not optional.
    if (!schemas.validateMergedReview(review)) throw validationError(`round ${files.name} review`, schemas.validateMergedReview);
  } else if (version === 1) {
    // Legacy: today's check, on today's line, over today's bytes.
    if (!schemas.validateReviewer(review.review)) throw validationError(`round ${files.name} review`, schemas.validateReviewer);
    if (review.meta.reviewers !== undefined) {
      throw new Error(`round ${files.name} review declares schemaVersion 1 but carries merge provenance`);
    }
  } else {
    throw new Error(`round ${files.name} review has unsupported schemaVersion ${JSON.stringify(version)}`);
  }
  if (review.meta.round !== round) throw new Error(`round ${files.name} review metadata has wrong round`);
  if (review.meta.planSha256 !== sha256(plan)) throw new Error(`round ${files.name} review is bound to a different plan`);
  if (version === 2) await verifyMergedCaptures(files, review, roster);   // the audit chain, checked
  reviews.push(review);
} else {
  slotReviews.set(round, await readSlotReviews(files, roster, plan, schemas));
}
```

The v1 branch preserves today's check order exactly — schema, then `round`, then `planSha256` — so a legacy artifact that was loadable yesterday is loadable today and reports the same error if it is not. **No version is inferred.** A missing, null, or unrecognized `schemaVersion` is a hard error, not a fallback to the branch with fewer checks; every `review.json` ever written has the field (`lib/workflow.mjs:216`), so nothing legitimate lands in the `default` arm.

The merged and unmerged branches both read every capture the round has. They differ in **what they check against**, and that difference is principled: before the merge there is nothing authoritative to check against, so a capture is validated against the current roster, plan, and schema; after the merge the round's own metadata is the authority, so a capture is checked against the hash the merge recorded.

**Post-merge — `verifyMergedCaptures(files, review, roster)`.** `review.meta.reviewers` is the round's manifest of which slots served and what each capture hashed to. The schema has already guaranteed it exists, is non-empty, and that every entry carries a well-formed `slot` and `captureSha256`; this function checks the things a schema cannot see:

- **Slot ids are unique** within `meta.reviewers` → `round 003 review lists reviewer slot R2 twice`.
- **The manifest is complete**: its slot set equals `roster`'s → `round 003 merged under slots R1 but the task roster is R1, R2`. This is what makes "a v2 round read fewer than N reviews" unrepresentable rather than merely unlikely, and it closes the truncation case — deleting an entry *and* its capture file together no longer produces a quietly smaller jury.
- For each entry: `reviews/<slot>.json` exists → else `round 003 is missing the committed review for slot R2`; and `fileSha256` of it equals `entry.captureSha256` → else `round 003 review for slot R2 does not match the sha256 recorded when the round merged`.
- A `reviews/*.json` file whose slot is not in `meta.reviewers` → `round 003 has a review for unknown reviewer slot R3`.

**The roster comparison does not violate §7.2's freeze**, and the distinction is the same one that governs everything else here: the frozen requirement forbids comparing a historical round against the **current override document**, because overrides move. The roster does not. It is fixed at task creation and no code path changes it (§1.1), so the comparison's answer is as constant as the round's own bytes — it can never start failing because a human ruled on a finding. It is the same class of check as `validateApproval`'s hash comparisons (`lib/workflow.mjs:468-473`): frozen input against frozen input.

**A v1 round is exempt from all of it**, and that exemption is now *claimed by the artifact* rather than inferred from a gap. A v1 round predates per-slot captures, so none exist and none are read. The invariant behind the exemption: v1 rounds can only have been written by the old code, which only ever wrote singular reviewer keys, so a v1 round implies a legacy task whose roster normalizes to `[R1]` — the exemption cannot smuggle a multi-slot round past verification, because a multi-slot round cannot be v1.

A sha match is the *complete* check on a v2 capture, which is why nothing else is re-run on one: the capture was fully validated at capture time by `normalizeSlotReview`, the merge hashed the exact bytes it read, and identical bytes cannot have become schema-invalid or differently bound. Re-validating the schema and the round/slot/plan bindings on bytes already proven identical would be belt-and-braces that can only drift from the checks that actually ran.

This is what makes "authoritative" mean something for `reviews/RN.json`. The merged document asserts that R2 raised F003; without this check, deleting or editing `reviews/R2.json` leaves that assertion unfalsifiable and the audit chain silently broken — in a tool whose entire product is an audit chain.

The consequence is owned, not hidden: `.plan-forge/` is gitignored (`docs/design.md:281`), so a capture deleted by hand cannot be restored and the task cannot be loaded again. That is the same, already-accepted consequence as a tampered `approval.json`, it requires editing a runtime directory the tool tells you not to touch, and the plan itself — the work product — is published under `docs/plans/` and survives in git regardless. The error names the file and the expected hash so the operator knows immediately what happened rather than debugging a confusing downstream failure.

**Pre-merge — `readSlotReviews`.** Validates each file against `schemas.validateReviewer`, checks `meta.round`, `meta.planSha256`, and `meta.slot`, rejects a file whose slot is not in the roster (`round NNN has a review for unknown reviewer slot RX`), and returns `Map<slotId, { wrapper, fileSha256 }>`. At most one round is ever in this state — the in-flight one. The existing round-contiguity and orphan-projection checks are untouched.

It also checks the capture against the **frozen configuration of the slot that was supposed to produce it** — the half of §3.1's preflight that only becomes observable once a provider has actually run:

- `meta.provider !== slot.provider` → `round 003 review for slot R2 was produced by codex, but the slot is configured for claude`.
- `slot.model && meta.model !== slot.model` → `round 003 review for slot R2 records model gpt-5-mini, but the slot is pinned to gpt-5.6`.

**The model check is conditional on the slot pinning one, and that condition is exactly what keeps N=1 intact.** An N=1 slot stores `model: null` and late-binds from the environment (§1.2), so its capture legitimately records whatever the env resolved to on the day it ran; a resume under a changed `PLAN_FORGE_CODEX_MODEL` must not reject it, and with `slot.model` null the check does not run. At N>1 every slot is pinned (§1.2), so the check always runs where there is something to check — which is the configuration where the audit record naming the right juror is the whole point (AC5).

Both are hard errors rather than supersessions. The roster is frozen at creation, so a capture disagreeing with its slot cannot come from a legitimate configuration change: it is tampering, or a composition bug that §3.1 now catches before it can happen again. Re-running the slot would spend a provider call to paper over the disagreement instead of reporting it. Recovery differs from the post-merge case in a way worth stating: the round has not frozen, nothing references the capture, so **deleting the offending `reviews/RN.json` is a complete repair** — the slot becomes pending and re-runs (§7.4). A deleted *merged* capture, by contrast, is unrecoverable.

These checks are disjoint from §7.3's fingerprint rule, and the two questions should not be confused: the fingerprint asks whether a capture answers the round's *current question*, these ask whether the *configured juror* produced it.

#### 7.2 The merge is the freeze point (AC8, second sentence)

`review.json` is an **authoritative commit, not a repairable projection**. Once it exists, it is read verbatim and never recomputed. This is not a stylistic choice — it is forced:

- The merged verdict depends on the overrides in force at merge time (`collectFindings` applies overrides last).
- So re-deriving `review.json` on load would compute it against **current** overrides, and a later override would silently rewrite a committed round's verdict. That is exactly the trap the frozen-requirement constraint names.

**Two load-time checks look alike and are not.** Comparing **frozen bytes to a frozen hash is required**: both sides were fixed when the round merged, no current state enters, and the answer can never change for a round whose files are intact. That is §7.1's capture verification, and it is what keeps the audit chain honest. Re-**deriving** the merge and comparing is **forbidden**: arbitration and the verdict run through `collectFindings`, which applies *current* overrides last, so the derivation's answer moves whenever a human rules on any finding — and a committed round would start failing to load after an unrelated override. Stated as a rule the implementation must not violate: **there is no check anywhere that recomputes a merged review from `reviews/*.json` and compares it to `review.json`.** The natural instinct is to reach for exactly that as "integrity verification"; the hash check gives the integrity without the override coupling, which is precisely why the merge records `captureSha256`.

The same test sorts the schema and roster checks §7.1 adds: `validateMergedReview` reads only the artifact's own bytes, and the roster comparison reads only a value frozen at task creation. Neither consults the overrides document, so neither can make a committed round's loadability depend on a later human ruling.

The in-flight round is the only place override freshness is a question, and §7.3 answers it. If `review.json` is missing while all slots are committed and fresh (a crash between the last capture and the merge), resume merges **now**, under current overrides. The round has not frozen yet, so that is its correct context.

The interaction is coherent in the other direction too: `applyOverride` validates against `collectFindings(...)`, which only knows **merged** rounds, so a finding from an unmerged round's slot captures does not exist yet and cannot be overridden. There is no window in which an override can target a finding whose ID is not yet allocated.

Behavior after an override on a frozen round is today's, unchanged: round 2's `review.json` still reads `changes_requested`, `runWorkflow` does not finalize, `blockingFindings` is empty after the override, and the loop spends one more round with the overrides visible (`lib/workflow.mjs:566-586`). The committed artifact is not touched.

#### 7.3 The round prompt fingerprint

A round asks every reviewer one question. `buildReviewerPrompt` *is* that question, and `sha256(prompt)` — already computed and already stored in every capture as `meta.promptSha256` (`wrapperMeta`, `lib/workflow.mjs:213-233`) — is its fingerprint. The rule:

> **A committed capture belongs to the round's current attempt iff its `meta.promptSha256` equals the prompt built from current context. A capture with any other fingerprint is superseded: its slot re-runs, and the round merges only once every slot has a capture at the current fingerprint.**

The fingerprint covers every input to the prompt, so nothing that changes the question can slip past it: the requirement (immutable), the plan (committed for the round), active findings, closed findings, the author's resolutions, the overrides document, `AGENTS.md`, and the prompt templates themselves. In practice **the overrides document is the only one that can move while a round is in flight** — everything else is either immutable or committed — with two rare exceptions the rule handles correctly for free: editing `AGENTS.md` or upgrading the tool mid-round also re-fans-out, which is right, since merging reviews written against two different sets of project guidance or two different reviewer prompts is not a merge.

**Why this is necessary, concretely.** Without it, a round can merge dispositions taken against different questions:

- A `withdrawn` override on a prior-round finding removes it from `activeFindings`. R1's committed capture dispositions it; a re-run R2 is never asked about it. The merged round then carries a disposition from one reviewer and none from the other, and R1's answer is silently dropped — while `review.meta.promptSha256` becomes a claim that cannot be true of both captures.
- Worse, a `severity_changed` override **re-opens a closed finding**: `applyOverrides` sets `finding.closed = false` (`lib/findings.mjs:68-72`). The fresh active set *grows*. R1's committed capture has no disposition for the reopened finding, so §4.2's "each active finding arrives with N dispositions" is false and `arbitrate` reduces over an array containing `undefined`.

Both are averted by one predicate over a field that already exists — no new artifact, no snapshot document, and no second freeze point competing with §7.2's.

**The alternative I rejected:** pinning the round's overrides at fan-out and having later slots use the pinned copy. It preserves "re-run only the failed slot" in every case, and the override would still take effect on the findings (`collectFindings` applies overrides last, regardless of what any reviewer said). But it costs a new persisted snapshot artifact, a second read path, and a second freeze point that has to be explained everywhere §7.2 is; it makes a reviewer disposition a finding a human has already withdrawn, inviting it to re-raise the defect under a fresh ID that the override does not cover; and it re-introduces the exact confusion this plan exists to remove — two documents disagreeing about which overrides are in force. One freeze point is worth one rare re-run.

**The superseded capture is overwritten**, by the same atomic rename any capture uses, and the supersession is recorded in `run.log` with both fingerprints. It is not archived: it was never part of a merged round, no finding references it, and §7.2's freeze covers merged rounds only. A `reviews/R1.superseded-<sha>.json` graveyard would add layout surface and would collide with §7.1's unknown-slot check for no audit gain.

#### 7.4 Partial-failure recovery — Q4 / AC8

Recovery needs no special case: **the runner invokes every slot that has no committed, fresh review file.** A resume after R2 failed re-runs R2 and only R2, because R1's file is present and its fingerprint still matches. This is the artifact-graph recovery model of `docs/design.md` §3 applied unchanged.

**How this squares with AC8's "resume re-runs only the failed reviewer."** It holds for every failure-driven resume, which is what AC8 is about: a crash, a timeout, a provider error, a rejected output — none of these touch the round's inputs, so no healthy work is ever discarded because something failed. The single exception is a human override landing between two slots of the same round, and it is not a weakening of AC8 but a consequence of the barrier: the override changed what *every* reviewer was asked, so R1's answer is no longer an answer to this round's question. Re-running it is not discarding healthy work; it is declining to merge answers to two different questions (§7.3). The exception is human-triggered, requires a task already stopped mid-round, and costs one extra reviewer call per healthy slot.

The trade-off Q4 asks for:

- **Recompute saved**: (N−1)/N of a round's reviewer spend on every slot failure. With `maxProviderFailures: 2` and N=3, discarding the round instead would re-pay 2 healthy slots per retry — up to 4 wasted reviewer calls per round.
- **Anchoring cost**: the re-run slot receives the **same byte-identical prompt** as the original pass — guaranteed, since a differing prompt is exactly what makes the peers' captures stale too. Nothing about a peer enters it. Reading `reviews/R1.json` requires the model to go looking, unprompted, at a path nothing points it to. That is a real but unenforced boundary, and the frozen requirement rules it explicitly not a blocker.
- **The honest framing**: this window is **not specific to resume**. R1 commits the moment it returns while R2 may run for minutes more, so the first pass has the same exposure. The only thing that would close it is buffering all N in memory until the barrier — which is what `concurrent-reviewers-v2` did, and it is what broke recovery. Per-slot commit is what AC8 requires; the readability window is its inseparable cost, not an oversight. §10 documents it rather than claiming it away.

`inspectTask` reports the in-flight state: when `phase` is `reviewing` it computes `failureStatus` per **pending** slot (worst status wins: `needs_human` > `failed` > `running`) and adds `pendingReviewerSlots: ['R2']` to the status JSON, where "pending" carries §7.3's meaning — no capture, or a superseded one. Additive, and it makes AC8 observable from the CLI.

### 8. Per-slot failure accounting

Failure records gain a `slot` field (`null` for author phases, `R1`…`Rn` for reviewing). `failureCount` gains an optional slot filter:

```js
async function failureCount(paths, phaseKey, slot = null) {
  const entries = await readFailures(paths);
  const lastClearance = entries.filter((e) => e.kind === 'clearance')
    .reduce((max, e) => Math.max(max, e.sequence), 0);
  return entries.filter((entry) =>
    entry.kind !== 'clearance' && entry.phaseKey === phaseKey && entry.sequence > lastClearance
    && (slot === null || (entry.slot ?? 'R1') === slot)
  ).length;
}
```

The `phaseKey` stays `reviewing:003` — **not** `reviewing:003:R2`. Slot-scoping the key would orphan the failure records of every existing task, silently handing a task that was one failure from `needs_human` a fresh budget. Instead `(entry.slot ?? 'R1')` normalizes legacy records to R1 at read time, so N=1's counts are preserved exactly. Author phases pass `slot = null` and are untouched.

A slot's budget is its own: R2 failing twice latches `needs_human` without spending R1's budget, which is right — the failures are independent events from independent subprocesses.

`handlePhaseFailure` stays as-is for author phases. Reviewing gets `handleReviewFailures`, which is its N-ary generalization:

```js
async function handleReviewFailures(context, { round, failures, logger }) {
  const phaseKey = phaseKeyOf('reviewing', round);
  const latched = [];
  for (const { slot, error } of failures) {                    // failures in roster order
    await recordFailure(context.paths, {
      round, phase: 'reviewing', phaseKey, provider: slot.provider, slot: slot.id,
      errorClass: normalizedErrorClass(error), attempts: error.attempts ?? 1,
      message: String(error.message || '').slice(0, 500), rejectedOutput: error.rawOutput ?? null
    });
    const count = await failureCount(context.paths, phaseKey, slot.id);
    if (count >= context.task.maxProviderFailures) latched.push(slot.id);
    logger.error('phase failed', {
      phase: 'reviewing', round, provider: slot.provider, slot: slot.id,
      status: count >= context.task.maxProviderFailures ? 'needs_human' : 'failed', consecutiveFailures: count
    });
  }
  const status = latched.length ? 'needs_human' : 'failed';
  await writeState(context, { status, phase: 'reviewing', round, errorClass: normalizedErrorClass(failures[0].error) });
  if (status === 'needs_human') return { status, phase: 'reviewing', round, errorClass: normalizedErrorClass(failures[0].error) };
  throw failures.length === 1
    ? failures[0].error
    : new Error(`reviewer slots ${failures.map((f) => f.slot.id).join(', ')} failed: ${failures[0].error.message}`);
}
```

At N=1 this reduces to today's `handlePhaseFailure` exactly: one record, one count, the same state write, and the original error rethrown so the CLI's message is unchanged. `clearFailures` clears all open failures regardless of slot and needs no change.

**Resume-time effort.** `resume --reviewer-effort <e>` applies to **every** slot. `updateTaskSettings` currently evaluates `resolveEffort(task.reviewer, reviewerEffort)` (`lib/workflow.mjs:770`), which throws `unsupported provider undefined` for any roster task, so it becomes: with a roster present, write `reviewers[i].effort = resolveEffort(reviewers[i].provider, reviewerEffort)` for every slot; otherwise today's line, untouched. At N=1 that is today's behavior; at N>1 it is what the flag plainly means. Effort is not slot identity, and changing it mid-task is already allowed today.

That moves the value, so its two readers move with it. `updateTaskSettings` returns the updated task, and `cli.mjs:195-199` logs `reviewerEffort: updated.reviewerEffort` — a key roster tasks no longer have, which would log `undefined`. It reads the roster instead: `reviewerEffort: reviewerSlots(updated).map((slot) => slot.effort).join(',')`, which is `high` at N=1 (today's line, byte-identical) and `high,xhigh` for a two-slot roster. Same shape and same reason as `reviewerLabel` (§1.1): after the roster lands, the singular keys have exactly two readers left in the tree and both are string labels. The other reader is the existing resume-settings test, which asserts on the same value and moves with it (see Verification).

### 9. Backward-compatibility ledger

Every deviation from byte-identical N=1 output, and why it is equivalent:

| Surface | N=1 today | N=1 after | Verdict |
|---|---|---|---|
| `rounds/NNN/review.json` path + `review.{verdict,previousFindings,newFindings}` | as today | **identical** | ✓ byte-identical |
| `review.json` `newFindings[].relatedToFindingId`, same-output relation | the earlier same-output finding's real id | **identical** — capture defers, merge resolves (§4.1.1) | ✓ byte-identical; streak inheritance unchanged |
| `review.json` `meta.schemaVersion` | `1` | **`2`** on rounds this code merges; `1` still read, on today's exact validation line | equivalent — **no reader exists**: the only version check in the tree is `task.schemaVersion` (`lib/workflow.mjs:347`), `manifest` copies `review.meta` without inspecting it (`:447`), `approval` pins by whole-file sha. It is what makes the format explicit (§2.1, §7.1) |
| `review.json` `meta` round-level fields | `round`, `planSha256`, `promptSha256`, `startedAt`, `completedAt`, `gitHead`, `gitDirty` | **same names, same meanings**; `completedAt` is the merge instant (ms later) | equivalent; the one consumer (`publishForHuman`) is unchanged |
| `review.json` `meta` per-slot fields | flat `provider`, `model`, `cliVersion`, `effort`, `usage`, `costUsd`, `sessionId` | same fields inside `meta.reviewers[0]`, plus `captureSha256` | additive nesting; runtime artifact, no field-level consumer |
| `review.json` `newFindings[]` | no `raisedBy` | `raisedBy: "R1"`, `sourceIndex`, both **required** at v2 | additive |
| `review.json` `previousFindings[]` | triple | same triple + `arbitration` (1 entry), **required** at v2 | additive |
| `rounds/NNN/reviews/R1.json` | absent | new capture file at `schemaVersion: 1` (its first format), hash-verified at load; may carry a `P<k>` reference (§4.1.1) | additive |
| reviewer output accepted/rejected set | `knownIds` grows as ids are allocated (`lib/findings.mjs:187`) | **identical set, identical messages** (§4.1.1) | ✓ no output the tool accepts today is rejected |
| `author-output.json` | provider output verbatim | **provider output verbatim** — normalization is in-memory (§5.1) | ✓ byte-identical |
| CLI with **no** `--reviewer` | defaults to `codex` (`cli.mjs:92`); `--reviewer-model` binds with no `--reviewer` present (`cli.mjs:103`) | **identical** — one default `codex` slot, order-independent binding (§1.3) | ✓ byte-identical; both commands unchanged |
| `task.json` (new tasks) | singular keys; `reviewerModel` = raw flag or null | `reviewers: [{…}]`; `model` = **raw flag or null at N=1** (resolved only at N>1, §1.2) | ✓ equivalent; env still late-binds at N=1; legacy shape still read |
| reviewer model at run/resume | `resolveModel(task.reviewer, task.reviewerModel ?? null)` per run | **the same call**, per slot | ✓ identical; env change between rounds still switches the model at N=1 |
| `updateTaskSettings` return + `task.json` effort key | `reviewerEffort: 'high'` | `reviewers[0].effort: 'high'`; no singular key | equivalent; both readers migrated (§8) — same values, same `invalid effort` rejection |
| `approval.json` | 7 keys, `reviewSha256` | **same 7 keys**, same meaning | ✓ old approvals revalidate |
| published headers (`docs/plans/<id>.md`, `needs_human/<id>.md`) | `reviewer=codex` | `reviewer=${reviewerLabel(task)}` → `codex` | ✓ byte-identical; also fixes `undefined` on roster tasks |
| `needs_human/<id>.md` brief | no attribution | finding heading names the raising slot | deviation — see below |
| reviewer prompt, finding view | as today | **identical** | ✓ byte-identical — no `raisedBy` reaches a reviewer |
| reviewer prompt, revision round | serialized raw resolutions | + `coversFindingIds: []` per resolution (§5.1) | equivalent — additive field the reviewer never reads; the enforced invariant is byte-equality *across a round's slots* (§6, §7.3), not with today |
| author prompt | no `raisedBy` | `raisedBy: "R1"` per finding | reworded prompt; output equivalent |
| author schema | 4 resolution fields | + `coversFindingIds`, required on the wire, defaulted by every reader | ✓ omission is accepted and means today's semantics (§5.1) |
| `run.log` provider stderr | `codex:stderr` prefix | same prefix, `slot="R1"` field | additive; not a published artifact |
| `run.log` resume-settings line | `reviewerEffort="high"` | same field, roster-derived → `high` | ✓ byte-identical at N=1 |
| `manifest.json` | `reviewerMeta` | `reviewers: [...]`, `mergeSha256` | see below |
| `status` JSON | as today | + `raisedBy`, `pendingReviewerSlots` | additive |

Two deliberate deviations, called out rather than buried:

- **`manifest.json` drops `reviewerMeta` for `reviewers: [...]`.** Nothing reads the manifest — it is "only a per-round audit summary, never the sole commit marker" (`docs/design.md:373`) — and `writeManifest` returns early when the file exists, so **no historical manifest is rewritten**. At N=1 the information content is identical, nested one level. Retaining `reviewerMeta` at N=1 only would be exactly the parallel single-reviewer path the requirement asks me not to build.
- **The decision brief names the raising slot** in each finding heading (`## F001 — blocker · Implementation (raised by R2)`). This changes the bytes of a published artifact at N=1. It is justified: AC5 requires every finding be traceable to its reviewer, and the brief is the human-facing surface where that matters most — with N reviewers, "which of them says this blocks?" is the first question a human asks. The decision the brief drives is unchanged, which is the contract the requirement actually sets. The file is only rewritten when a task re-stops (`writeIfChanged`), so no existing stopped task churns until it runs again.

Model resolution is **not** on this list, and §1.2 explains why: N=1 keeps today's late binding exactly, and creation-time pinning is scoped to N>1, which has no prior behavior to preserve. §7.1's capture-vs-slot model check inherits that scoping — it is skipped wherever the slot pins nothing, which is every N=1 task.

### 10. The accepted boundary

Stated plainly, because two prior plans died claiming otherwise:

> **A reviewer slot can read its peers' committed reviews.** `.plan-forge/` lives inside the repository; the codex adapter runs `--cd repoRoot --sandbox read-only` (`lib/providers/codex.mjs:27-29`) and the claude adapter grants `Read,Glob,Grep` over the repo (`lib/providers/claude.mjs`). Both bound *writes* and *tool sets*, not *paths*. A slot still running can therefore open `rounds/NNN/reviews/R1.json` for a peer that already returned, on the first pass and on any re-run.

This is not fixed, mitigated by obscurity, or narrowed by a prompt instruction. The `concurrent-reviewers-v2` analysis enumerated the alternatives — relocation, obscurity, encryption, keychain, mode bits, OS read jail — and showed each either fails to enforce or requires changing the provider adapters, a stated non-goal. The human ruling in the frozen requirement is that independence exists to widen coverage, and that is delivered by **what is in the prompt**. Same-UID readability is accepted and documented here and in `docs/design.md` §5.3.

What is actually guaranteed, and is testable: no peer's findings, raw output, or derived artifact appears in any reviewer's prompt; all N prompts in a round are byte-identical, enforced at the merge by §7.3 rather than assumed; and no instruction anywhere points a reviewer at a peer's output.

### 11. Files touched

- `lib/merge.mjs` — **new**: `mergeRoundReviews` (pure; takes the round `promptSha256` and each capture's `fileSha256`; stamps `meta.schemaVersion: 2`; allocates ids, sets `raisedBy`/`sourceIndex`, and resolves slot-local references per §4.1.1), `arbitrate`, `outcomeRank`.
- `lib/roster.mjs` — **new**: `reviewerRosterFromArgs` (pure; the zero/one/many `--reviewer` binding rules of §1.3, provider validation, and the `--allow-same-provider` guard, all with today's error strings).
- `schemas/merged-review.schema.json` — **new**: orchestrator-internal, validates the **whole v2 wrapper**, `meta.schemaVersion: {const: 2}`, `meta.reviewers` non-empty with `slot`+`captureSha256` required per entry, `raisedBy`/`sourceIndex`/`arbitration`/`summaries` required (§2.1).
- `lib/findings.mjs` — split `normalizeReviewerOutput` → `normalizeSlotReview` (no ID allocation; slot-local reference resolution, §4.1.1; provisional-ID verdict self-check); `validateAuthorResolutions` gains `coveredIds`. `collectFindings` / `applyReviewToMap` / `nextFindingNumber` unchanged.
- `lib/workflow.mjs` — `reviewerSlots`, `reviewerLabel`; roster validation in `loadContext` (shape only, no model resolution); `initializeTask` writes the roster, rejects an empty one, and pins models via `resolveModel` **only when N>1** (§1.2); `assertReviewerAdapters` called after each `loadContext` (§3.1); `normalizeAuthorOutput`, applied at capture (`:624-627`) and at load (`:320`), with projections and hashes taken from the stored bytes; `loadRoundArtifacts` dispatches `review.json` on the declared `meta.schemaVersion` (`:332-338`) — v2 through `validateMergedReview` + `verifyMergedCaptures(files, review, roster)`, v1 through today's `validateReviewer` line plus a no-merge-provenance check, anything else a hard error — and reads N slot reviews per round via `readSlotReviews` (with the slot-config checks) on the in-flight one; the fan-out/fingerprint/barrier/merge reviewing phase; `handleReviewFailures`; `failureCount` slot filter; `writeManifest` `reviewers`/`mergeSha256`; `publishForHuman` and `finalize` headers via `reviewerLabel` (`:170`, `:511`), brief attribution; `inspectTask` pending slots; `updateTaskSettings` per-slot effort (`:770`). `resolveModel` and `wrapperMeta`'s `schemaVersion: 1` (`:216`, which now stamps captures) are unchanged.
- `lib/prompts.mjs` — add `authorFinding` (with `raisedBy`, defaulted to `R1` only for v1 rounds); `sanitizedFinding` unchanged.
- `lib/artifacts.mjs` — `roundPaths` gains `reviewsDir` and `slotReview(slotId)`; `recordFailure` carries `slot`.
- `lib/schema.mjs` — compile `validateMergedReview` and expose `mergedReviewSchema` (test 34 reads it).
- `cli.mjs` — `parseArgs` `tokens`; `taskOptions` delegates the reviewer half to `reviewerRosterFromArgs` (`:92-98`, `:103`, `:105`, `:113-114`) and keeps every other option; `buildRuntime` → `providers.reviewers`, one `resolveModel` per slot (`:80-85`); the resume-settings log line reads the roster (`:195-199`).
- `schemas/author-output.schema.json` — `coversFindingIds` in `properties` **and** `required`.
- `prompts/revise.md` — `coversFindingIds` section. `prompts/reviewer.md` — **unchanged**.
- `test/helpers.mjs` — `initTask` passes roster options (§ Verification).
- `docs/design.md` — §2 layout and the `schemaVersion` per-format rule, §3 the fingerprint rule and capture verification, §4.2 the declared-format dispatch, merged review, arbitration, and the slot-local reference rule, §4.3 `coversFindingIds` and the normalize-before-validate rule, §5.3 the §10 boundary, §6 the CLI roster rules including the default `codex` slot and the N>1 slot-model pinning rule, §7 arbitration → stall gate, §9 tests.

## Verification

### Existing suite

`node --test test/` passes with the changes below, which are the **complete** set — each one is forced by a production change, and no other existing test or fixture is touched. Completeness is checked, not asserted: a grep for the singular reviewer keys (`task.reviewer`, `reviewerModel`, `reviewerEffort`, `claudeReviewerMaxBudgetUsd`) and for `providers.reviewer` across `test/` returns exactly the sites below plus `test/live.test.mjs:22`'s `reviewerTimeoutMs`, which stays round-level (§1.1) and needs nothing.

- **`test/helpers.mjs:63-84`** — `initTask` passes roster options: `reviewers: [{ provider: 'codex', model: null, effort: null, claudeMaxBudgetUsd: null }]` replaces `reviewer` / `reviewerModel` / `reviewerEffort` / `claudeReviewerMaxBudgetUsd`. This is **required**, not cosmetic: `initializeTask` consumes `options.reviewers` (§1.2) and would otherwise reject an empty roster. All 15 `initTask` call sites override only `maxRounds`, `publishDir`, `requirementText`, timeouts, or `claudeAuthorMaxBudgetUsd` — none names a reviewer key — so the helper edit covers every caller with no call-site churn.
- **`test/workflow.test.mjs:29`** — `runtime()`'s `providers: { author, reviewer }` → `providers: { author, reviewers: [reviewer] }`. One line; every assertion holds, including the three that read `review.json` directly (`:145`, `:324`, `:329`). It also satisfies §3.1's preflight, since the fake's `name` is `'codex'` and the roster's one slot is `codex`.
- **`test/live.test.mjs:31-34`** — the same providers change: `reviewer: createCodexProvider({ repoRoot })` → `reviewers: [createCodexProvider({ repoRoot })]`.
- **`test/workflow.test.mjs:265-285`** (`resume-time setting overrides persist into task.json`) — the one existing test that reads the singular reviewer keys off `task.json`, and it must move with them: §1.1 stops writing `reviewerEffort` for new tasks and §8 stores effort in `reviewers[0]`. `before.reviewerEffort === 'high'` (`:271`) → `before.reviewers[0].effort === 'high'`; `updated.reviewerEffort` (`:274`) and `persisted.reviewerEffort` (`:280`) → `updated.reviewers[0].effort` and `persisted.reviewers[0].effort`, both `'xhigh'`. Add `persisted.reviewers.length === 1` and `persisted.reviewers[0].provider === 'codex'`, so the test proves the roster was *updated* rather than replaced or dropped — the thing §1.1's frozen-shape rule actually promises. Everything else in the test is untouched and still holds: `before.authorEffort` / `updated.authorEffort` (`:270`, `:276`) are author-side and §8 does not touch the author line; `reviewerTimeoutMs` (`:273`, `:279`) stays round-level; and the `/invalid effort "max" for codex/` rejection (`:281-284`) still throws that exact message, because §8's roster branch calls `resolveEffort(slot.provider, 'max')` with `slot.provider === 'codex'` — the same call today's line makes with `task.reviewer`.
- **`test/findings.test.mjs`** — the two assertions that read an **allocated id** off the normalizer's result (`:52`, and `:184`'s `.normalized.newFindings[0].id === 'F002'`) **move** to `test/merge.test.mjs`, because allocation moves to `lib/merge.mjs`; at merge `:184`'s case additionally asserts the prior-round `relatedToFindingId: 'F001'` still passes through verbatim. That is relocating an assertion to the code that now owns the behavior, not dropping it. Everything else in the file stays with `normalizeSlotReview` **including all three relation-agreement throws** (`:181-183`) — `unknown id F404` still throws with today's message under §4.1.1, since `F404` is neither a prior id nor a position-predicted one. The completeness (`missing=[F001]`), coercion, and verdict assertions are untouched; the two that read `result.findings` (`:108`, `:111`) assert against `collectFindings` on a merged document instead. The `validateAuthorResolutions` fixtures (`:189-193`) are unchanged — `coversFindingIds` is read through `?? []` (§5).

I chose to migrate the helper rather than teach `initializeTask` to accept singular options, for the same reason `runWorkflow` gets no `providers.reviewer` fallback shim: a production compatibility branch that exists only to serve a test harness is cruft with no consumer. Legacy *task.json files on disk* still normalize through `reviewerSlots` (§1.1); that is a real consumer, and it is unaffected.

**Fake author fixtures need no `coversFindingIds`.** `test/workflow.test.mjs:19-21` (`resolution()`), `:118-121`, and `:362-365` (`rejectF001`) stay as written, because §5.1 normalizes author output at the capture site (`lib/workflow.mjs:624-627`) as well as at load — the load path has to normalize for legacy rounds regardless, so both sites share it and an omitted field defaults to `[]`.

`test/prompts.test.mjs`, `test/artifacts.test.mjs`, `test/logging.test.mjs`, `test/providers.test.mjs`, `test/doctor.test.mjs` — unchanged. `test/schema.test.mjs` gains test 34 and is otherwise unchanged:

- `test/schema.test.mjs:13-30` walks **only** `authorSchema` and `reviewerSchema` (`:15`), so the new `mergedReviewSchema` is outside the provider-common subset test by construction and may use `const`, `pattern`, and optional-free strictness (§2.1). `coversFindingIds` is added to the author schema's `properties` **and** `required`, so the walk passes.
- `test/prompts.test.mjs:20`'s `{ findingId: 'F001', action: 'accepted' }` is rendered into a prompt, never schema-validated.
- `test/logging.test.mjs` calls `providerStderr('claude', …)` directly, and the prefix is untouched anyway.

`test/packaging.test.mjs` must still pass with the three new files — confirm `package.json`'s `files` covers `schemas/` and `lib/` by directory rather than by enumeration, and extend it if not.

### New tests

**Merge — `test/merge.test.mjs`** (pure, no providers)

1. **ID allocation is deterministic under completion order** (AC2): two slots each returning new findings, merged with R2's capture written first. IDs follow **roster** order — R1's finding is `F001`, R2's is `F002` — never completion order.
2. **ID allocation is race-free** (AC2): two slots each returning 2 new findings → `F001`–`F004`, 4 distinct IDs. Under today's capture-time allocation both slots would mint `F001`; assert no duplicate and that `applyReviewToMap` folds the merged doc without throwing.
3. **Arbitration, most-open-wins** (AC3): F001 blocker; R1 `resolved`, R2 `still_open` → merged `still_open` at blocker, `arbitration.winner === 'R2'`, **both** dispositions recorded.
4. **Arbitration, severity ladder** (AC3): R1 `severity_changed`→minor vs. R2 `still_open` (blocker) → stays blocker. R1 `severity_changed`→major vs. R2 `severity_changed`→minor → major.
5. **Arbitration, unanimous close + tie-break** (AC3): both `resolved` → closed, `winner === 'R1'`.
6. **Verdict is composed, not inherited** (AC4): R1 self-consistently `approved`, R2 `changes_requested` with a new blocker → merged `changes_requested`. Both `approved` → merged `approved`.
7. **N=1 merge is today's normalizer**: one slot in, merged `review.review.{verdict,previousFindings,newFindings}` deep-equals what `normalizeReviewerOutput` produces today for the same input (modulo `raisedBy`/`sourceIndex`/`arbitration`). Also assert `merged.meta.schemaVersion === 2` and that `validateMergedReview(merged)` accepts it — the merge cannot emit an artifact its own loader rejects.
8. **Overrides are not arbitrated**: a `severity_changed`→blocker override on a finding both slots downgrade to nit still yields a blocking merged verdict — pinning the §4.3 drift the direct-scan shortcut would have introduced.

**Same-output relations — `test/merge.test.mjs` + `test/findings.test.mjs`** (§4.1.1)

28. **A same-output relation survives the capture/merge split, unchanged at N=1** (AC1/AC2). Prior state holds `F001` and `F002`, so `base` is 3. One slot returns two new findings: A with `relatedToFindingId: null`, and B with `relatedToFindingId: 'F003'` (A's position-predicted id) and `relationKind: 'recurrence'`, both `blocker`. Assert, with today's `normalizeReviewerOutput` on the identical input as the oracle:
    - capture: both ids `null`; B's `relatedToFindingId === 'P1'`;
    - merged: `A.id === 'F003'`, `B.id === 'F004'`, `B.relatedToFindingId === 'F003'`, `B.relationKind === 'recurrence'` — deep-equal to the oracle's `normalized.newFindings` modulo `raisedBy`/`sourceIndex`;
    - fold: `collectFindings` over the merged doc gives `F003.criticalReviewStreak === 0` and `F004.criticalReviewStreak === 1`, matching the oracle exactly — the inheritance at `lib/findings.mjs:44,53`;
    - verdict: merged verdict equals the oracle's, and the slot's own self-check accepts the same verdict it accepts today.
    Rejections still hold, with today's messages: A naming `'F004'` (a forward reference) throws `unknown id F004`; B naming `'F099'` (past the end) throws `unknown id F099`; B naming `'F001'` (a prior round) is accepted and passes through unrewritten.
29. **A slot-local reference never binds to a peer's finding** (N>1). Prior state holds `F001`/`F002` (`base` 3). R1 returns 2 new findings; R2 returns 2, its second naming `'F003'` with `relationKind: 'recurrence'` — R2's own position-predicted first finding, which at N=2 is *actually R1's* allocated id. Assert R1 → `F003`,`F004` and R2 → `F005`,`F006`, and that R2's second finding has `relatedToFindingId === 'F005'` — **its own** first finding, not `F003`. Assert `F006.criticalReviewStreak` inherits from `F005` and that `F003`'s streak is untouched. This is precisely the silent mis-binding a "prior ids ∪ allocated-so-far" check would have produced.

**Roster construction — `test/roster.test.mjs`** (pure, no I/O)

30. **The CLI's flag rules, including the default reviewer** (§1.3, AC1). `reviewerRosterFromArgs({ author: 'claude', tokens, values })`:
    - **no `--reviewer`, no `--reviewer-model`** → exactly `[{ provider: 'codex', model: null, effort: null, claudeMaxBudgetUsd: null }]` — today's `values.reviewer || 'codex'` default (`cli.mjs:92`) with today's null model. This is the plain `plan-forge run --task t --requirement r.md` invocation, and it is the case the roster rules must not drop.
    - **no `--reviewer`, `--reviewer-model gpt-5.6`** → one `codex` slot with `model: 'gpt-5.6'`. Today `cli.mjs:103` reads the model flag with no reference to `values.reviewer`, so this command works today and must keep working.
    - **`--reviewer-model gpt-5.6 --reviewer codex`** (flag before the slot, one reviewer) → the same one-slot roster with the model bound: order-independence at N=1.
    - **`--reviewer codex --reviewer claude --reviewer-model o`** → `o` binds to R2 only; R1's model stays null.
    - **`--reviewer-model o --reviewer codex --reviewer claude`** → throws `must follow the --reviewer it configures`.
    - **`--reviewer gemini`** → throws `--author and --reviewer must be claude or codex`, today's exact message.
    - **author `claude` + one `claude` slot, no flag** → throws `author and reviewer must differ unless --allow-same-provider is set`, today's exact message; **with `--allow-same-provider`** → passes. **Two `codex` slots, author `claude`, no flag** → passes (§1.3).
    - **end to end**: `initializeTask` with `options.reviewers` from the zero-`--reviewer` case writes `task.json` with `reviewers: [{ provider: 'codex', model: null, … }]` and no singular reviewer keys — the default reviewer reaching disk in roster form, which tests 22 and 26 cannot show because the shared helper always passes an explicit roster.

**Dup coverage — `test/findings.test.mjs`**

9. **One resolution covers many** (AC7): required `[F001, F002]`, one resolution `{findingId:'F001', coversFindingIds:['F002']}` → passes.
10. **Double coverage rejected**: two resolutions both naming F002 → `duplicate resolution for F002`.
11. **Coverage gaps still caught**: `coversFindingIds` naming only F002 while F003 is active → `missing resolutions for F003`.
12. **Legacy author output loads** (§5.1): a stored resolution with no `coversFindingIds` normalizes and validates at load; `resolution.json` is **not** rewritten (sha unchanged after a `repair: true` load). A fresh provider output omitting the field is likewise accepted at capture and stored verbatim — `author-output.json` contains no `coversFindingIds` key.

**Workflow — `test/workflow.test.mjs`** (fake providers; delays via the existing function-output support in `fakeProvider`)

13. **Barrier: author runs once per round** (AC6): N=2, both reviewers file findings → `author.calls === 1` for the round, and the author's fake asserts both `reviews/R1.json` and `reviews/R2.json` exist and `review.json` exists when it is invoked.
14. **Prompt independence** (Q3): N=2 → `reviews/R1.json` and `reviews/R2.json` have **equal** `meta.promptSha256`, equal to `review.json`'s `meta.promptSha256`; the reviewer prompt's `ACTIVE FINDINGS TO DISPOSITION` block parses to JSON with **no** `raisedBy` key on any entry.
15. **Author sees attribution** (AC5): the author prompt's `ACTIVE FINDINGS` block carries `raisedBy` per finding and contains **no** provider or model name.
16. **Partial-failure recovery** (AC8): N=2, R1 succeeds, R2 fails → status `failed`, `reviews/R1.json` present, `review.json` absent. Resume with unchanged inputs → **only R2 is invoked** (R1's fake `calls` stays 1, R2's goes to 2), R1's capture file is byte-unchanged, the merge commits, the author runs once.
17. **A committed round survives a later override** (AC8): N=2, round 1 merges `changes_requested` with blocker F001. Record `sha256(review.json)`. Apply a `withdrawn` override, resume → round 1's `review.json` sha is **unchanged** and its verdict still reads `changes_requested`; the loop proceeds to round 2 with the override visible.
18. **Per-slot failure budget** (AC8): R2 fails twice → `needs_human` with `errorClass: 'provider_failure_limit'`; R1 is not re-invoked on the second pass; R1's budget is untouched.
19. **Legacy task resumes** (AC1): hand-write today's `task.json` (singular keys) plus a today-format `rounds/001/review.json` — `meta.schemaVersion: 1`, no `meta.reviewers`, no `reviews/` dir — and a today-format `author-output.json` (no `coversFindingIds`), then resume → round 1 normalizes to R1 with its sha **unchanged**, takes the v1 branch (`validateReviewer` on `review.review`, no captures read), round 2 is written at `schemaVersion: 2` in the new layout, and `approval.json` validates. Assert round 1's author prompt renders its findings with `raisedBy: 'R1'` — §6's default, exercised on the only artifact that can reach it.
20. **Two slots, one provider** (AC5): `codex:gpt-5.6` + `codex:gpt-5-mini` → both appear in `meta.reviewers` with distinct models, findings attributed to distinct slots.
21. **Roster validation at creation**: a two-slot roster with an unresolvable model throws at `initializeTask` (`reviewer slot R2 (codex) has no model`); an empty `options.reviewers` throws `a task needs at least one reviewer slot`. The `--allow-same-provider` cases live in test 30, where the guard now lives (§1.3).
22. **N=1 end-to-end equivalence** (AC1): the existing draft → blocker → revise → approve flow under `reviewers: [codex]` produces the same verdict, the same finding IDs, an `approval.json` with today's key set, and a published header matching `/^<!-- plan-forge: task=workflow round=1 author=claude reviewer=codex /`.
23. **A withdrawing override between two slots re-fans-out the round** (§7.3): round 1 merges with blocker F001; round 2's author revises; round 2's fan-out has R1 commit and R2 fail → `failed`. Apply `withdrawn` on F001, clear failures, resume → **both** slots run again (`R1.calls === 2`), `reviews/R1.json`'s `meta.promptSha256` changed and equals R2's and the merged `meta.promptSha256`, the merged `previousFindings` carries no disposition for F001, and round 1's `review.json` sha is unchanged.
24. **A reopening override is caught by the same rule**: same setup, but F001 was `resolved` in round 1 and the override is `severity_changed`→blocker, which sets `closed = false` (`lib/findings.mjs:68-72`) and so *grows* the active set. Assert the round re-fans-out rather than merging R1's capture, which has no disposition for the reopened finding; assert the merged round has N dispositions for every active finding.
25. **Merged captures are verified at load** (AC5): after a merged 2-slot round, (a) delete `reviews/R2.json` → `loadContext` throws `missing the committed review for slot R2`; (b) flip one byte of `reviews/R2.json` → throws the recorded-sha mismatch; (c) drop in a `reviews/R3.json` → throws `unknown reviewer slot R3`; (d) the untouched round loads clean and `review.json` is not rewritten. Test 19 covers the v1 exemption; test 33 covers the attempts to reach it.
26. **Slot model binding** (§1.2) — four cases, `resolveModel(provider, model, env)` already taking an injectable `env` (`lib/workflow.mjs:192`):
    - **(a) N=1 environment late-binding is preserved**: create with `PLAN_FORGE_CODEX_MODEL=model-a` and no `--reviewer-model` → `task.json` stores `reviewers[0].model === null`; resume with `PLAN_FORGE_CODEX_MODEL=model-b` → `buildRuntime` constructs the codex adapter with `model-b` and the round's capture records `meta.model === 'model-b'`. This is today's behavior, and this test is what pins it.
    - **(b) N=1 explicit flag still wins**: `--reviewer-model model-a` → stores `'model-a'`; `PLAN_FORGE_CODEX_MODEL=model-b` at resume → the adapter still gets `model-a`, matching today's `explicit → env` precedence.
    - **(c) N>1 environment-only pins at creation**: `PLAN_FORGE_CODEX_MODEL=gpt-5.6` with two codex slots and no flags → `initializeTask` succeeds and persists `model: 'gpt-5.6'` on both slots; changing the env var afterward changes neither the stored roster nor what `buildRuntime` passes to either adapter.
    - **(d) N>1 unresolvable throws at creation**: env unset, no flags → `initializeTask` throws `reviewer slot R2 (codex) has no model`.
27. **A multi-reviewer stall publishes a valid timestamp**: a stalled 2-slot task's `needs_human` header has `stoppedAt=` equal to the merged `meta.completedAt` and parsing as a valid ISO timestamp, and `reviewer=claude,codex`; re-running the stalled task does not rewrite the file (`writeIfChanged` + a frozen `completedAt`).
31. **A mismatched reviewer runtime spends nothing** (§3.1, AC5): a task whose roster is `[codex, claude]`, run through `runWorkflow` with `providers.reviewers: [claudeFake, codexFake]` → rejects with `reviewer slot R1 is configured for codex but the runtime supplied a claude adapter`; `claudeFake.calls === 0`, `codexFake.calls === 0`, **`author.calls === 0`**, and no `rounds/001/reviews/` directory exists. Same roster with a one-adapter array → `1 reviewer adapters were supplied for a 2-slot roster`, again with zero calls. Correctly ordered adapters run the round (test 13 is the control).
32. **A capture must agree with its slot** (§7.1): reusing test 16's mid-round state (R1 committed, R2 failed, no `review.json`) on a two-slot pinned roster —
    - (a) hand-edit `reviews/R1.json`'s `meta.provider` to the peer's provider → `loadContext` throws `was produced by … but the slot is configured for …`;
    - (b) hand-edit `meta.model` off the slot's pinned value → throws `records model … but the slot is pinned to …`;
    - (c) delete the offending capture and resume → R1 re-runs, the round merges, the task proceeds — the repair path, and the deliberate contrast with test 25(a), where a *merged* round's deleted capture is unrecoverable;
    - (d) **an N=1 task is unaffected**: its slot stores `model: null`, its capture records `codex-test`, and the round loads and merges with no error — the model check is skipped wherever the slot pins nothing, which is what keeps §1.2's late binding alive.
33. **A new-format merge cannot masquerade as legacy** (§2.1, §7.1, AC5). Start from a clean merged 2-slot round (test 25(d)'s fixture) and mutate `review.json` one way at a time; every case must **throw at `loadContext`**, and none may take the no-capture v1 path:
    - (a) delete `meta.reviewers`, leaving `schemaVersion: 2` → merged-schema failure naming `reviewers`. Under the earlier absence-as-signal rule this round would have loaded silently as legacy with zero captures read; this case is the regression guard for that.
    - (b) delete `meta.reviewers` **and** set `schemaVersion: 1` → the v1 branch's `validateReviewer(review.review)` rejects `raisedBy` as an additional property under the unchanged provider-common schema. Reaching the legacy branch demands stripping provenance from every finding too — a wholesale rewrite, which is the stated bound.
    - (c) keep `meta.reviewers` and set `schemaVersion: 1` → `declares schemaVersion 1 but carries merge provenance`.
    - (d) delete `meta.schemaVersion` entirely → `unsupported schemaVersion undefined`. Absence is an error, never a fallback.
    - (e) set `schemaVersion: 3` → `unsupported schemaVersion 3`.
    - (f) delete `raisedBy` from one merged new finding, and separately `arbitration` from one previous finding → merged-schema failures. Provenance is required at v2, not optional.
    - (g) `meta.reviewers` listing `R1` twice → `lists reviewer slot R1 twice`.
    - (h) `meta.reviewers` listing only `R1`, with `reviews/R2.json` deleted so the per-entry checks would otherwise pass → `merged under slots R1 but the task roster is R1, R2`. This is the truncated-jury case, and it is why the manifest is checked against the frozen roster.
    Assert in every case that `review.json` is not rewritten, and that a v1 round in the same task (test 19's fixture) still loads clean — the exemption survives, it just cannot be claimed by a v2 artifact.
34. **The merged schema cannot drift from the reviewer schema** — `test/schema.test.mjs`, pure. For `newFindings.items` and `previousFindings.items`, assert every key in `reviewerSchema`'s `required` also appears in `mergedReviewSchema`'s corresponding `required`, plus the merged-only provenance keys (`raisedBy`, `sourceIndex` / `arbitration`). This is what makes restating the finding body in `merged-review.schema.json` (rather than `$ref`-ing a provider-facing file, §2.1) safe: adding a field to the reviewer schema without adding it to the merged one fails here. Also assert `validateMergedReview` **rejects** a v1 wrapper and **accepts** a well-formed v2 one, so the two schemas' domains stay disjoint.

### Acceptance criteria

| AC | Where | Test |
|---|---|---|
| 1 — N concurrent; N=1 as today | §1.2, §1.3, §2, §2.1, §3, §4.1.1, §9 | 7, 12, 19, 22, 26, 27, 28, 30, 32(d), 33, full existing suite |
| 2 — ID allocation race-free, deterministic | §4.1, §4.1.1 | 1, 2, 28, 29 |
| 3 — arbitration defined + justified | §4.2 | 3, 4, 5 |
| 4 — verdict from the merged set | §4.3 | 6, 8 |
| 5 — every finding traceable | §2, §2.1, §3.1, §6, §7.1 | 15, 20, 25, 29, 31, 32, 33, 34 |
| 6 — barrier; author once per round | §3 | 13 |
| 7 — one resolution, many findings | §5 | 9, 10, 11 |
| 8 — partial recovery; frozen rounds | §7.2, §7.3, §7.4, §8 | 16, 17, 18, 23, 24 |
| 9 — no regressions; merge/arbitration/dup covered | §9, Existing suite | existing suite + 1–34 |

Done means: `node --test test/` green; a live two-slot smoke run (`PLAN_FORGE_LIVE=1`) completes one merged round across `claude` and `codex` with both `meta.promptSha256` equal to the merged round's and every merged finding attributed; and `docs/design.md` records the new layout, the declared-format rule (`meta.schemaVersion: 2` for merged rounds, `1` for legacy, no inference from absence) and the per-format meaning of `schemaVersion`, the arbitration rule, the fingerprint and capture-verification rules, the slot-local reference rule, the CLI roster rules including the default `codex` slot, the N>1-only model pinning rule, and the §10 boundary.

---

## Appendix: Frozen Requirement

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

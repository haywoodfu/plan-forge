<!-- plan-forge: task=concurrent-reviewers-atomic-round round=3 author=claude reviewer=codex status=needs_human stoppedAt=2026-07-16T10:17:16.942Z blockingFindingIds=F001 planSha256=f1394067fb2323ccbd9572dc2dc9b38e62c7751d1bee66b48564591a34a84b2b requirementSha256=2707ea2a87a73fd8de611572c7bd5d5b8cd6f344aed0b888699822d34a01202b -->

# Decision required — concurrent-reviewers-atomic-round

This plan **did not pass the gate**. It stopped at round 3 because a blocking finding survived two consecutive re-reviews.
Nothing below is approved. 1 finding(s) block it: F001.

## F001 — blocker · Implementation §7 and §11

**Problem**

Reviewer independence is not actually enforced. A completed Codex slot's structured result remains briefly accessible through its named output file while peers may still be running. The Windows stdout-spool fallback and live stderr/raw-derived terminal errors create additional persistence channels. These are incompatible with the frozen requirement's hard first-pass and rerun isolation constraint; documenting them as residual risks does not satisfy it.

**Required change**

Eliminate all tool-controlled named-output windows for supported multi-reviewer runs. Use an actually pathless mechanism for the Codex final result, reject multi-reviewer mode on platforms where output spools cannot be made pathless, and buffer raw stderr/raw-derived errors until a successful round commit; failed rounds must emit only content-free diagnostics. Test live first-pass observation and failed-round reruns, including redirected stderr and provider temporary paths.

**Evidence**

- `lib/providers/codex.mjs:24-36` creates `/tmp/plan-forge-codex-*/last-message.json`; `lib/providers/codex.mjs:51-63` reads it only after the subprocess exits, and `lib/providers/codex.mjs:79-80` removes it afterward. A still-running peer can glob and read that completed output during this interval.
- `lib/process.mjs:43-60` currently keeps stdout at a named path until collection. The plan closes this only where unlinking an open file works and explicitly accepts named-file behavior on Windows.
- `lib/process.mjs:157-165` embeds provider stdout/stderr in failure messages, and `cli.mjs:243-245` emits the full message to stderr. The plan also streams provider stderr live and merely advises operators not to redirect it into the repository.
- The frozen requirement says no findings, raw output, or artifact derived from them may be observable by a same-round peer on the first pass or any rerun.

**Reviewer's position** (last reviewed round 3, status `still_open`)

The named-file and stderr channels were improved, but independence remains unenforced. Section 11 explicitly permits N>1 on Linux while conceding that a same-uid reviewer can open peer descriptors through `/proc/<pid>/fd`; documenting that exception cannot narrow the frozen requirement. More critically, parent-process crashes leave detached provider process groups alive: `lib/process.mjs:63-68` spawns detached children, while `lib/artifacts.mjs:153-179` reclaims the lock based only on the dead parent PID. Resume can therefore start a new pass while an old same-round reviewer is still running; once the rerun commits `reviews.json`, that orphan can read its peers' output. The persisted `rejectedOutputSha256` is also explicitly derived from failed output, contradicting the plan's own promise that no derived byte survives at a pathname. Reject unsupported platforms or add real process isolation, ensure orphan groups are terminated before any rerun reviewer starts, remove output-derived failure fields, and test a parent SIGKILL with children still running.

**Author's position**

`accepted` — Accepted, and the finding is right for a reason the previous plan never considered: argv is public. `lib/providers/codex.mjs:36` passes `--output-last-message <path>` on the command line, and codex's `--sandbox read-only` restricts writes, not process execution — so a peer slot reads the path straight out of the process table with `ps`. That defeats the previous §7(e) entirely: an unlistable directory and a 128-bit random name are worthless when the name is published in argv. The second mechanism was independently unsound too, and this repository had already ruled on it: `docs/plans/needs_human/concurrent-reviewers-v2.md:100` records that a constraint holding only while a third-party CLI's sandbox denies `chmod` is 'the same species of claim as we asked the model not to look, wearing a mode bit' — and both slots run as the same uid, so the peer owns that directory. §7(e) is therefore rebuilt on namelessness rather than obscurity: `openNamelessTempFd` creates, opens `w+`, unlinks, and rmdirs before any child is spawned, so for the whole life of the run the bytes have no directory entry at all; the stdout spool is inherited by descriptor, and codex's result is written to `--output-last-message /dev/fd/3` over a second nameless fd — an argv token that resolves, in any peer's process, to that peer's own fd 3. The `0300` chmod survives only as explicitly non-load-bearing belt-and-braces for the microseconds inside that function, and §11 lists that window as a residual rather than claiming it closed. The one external assumption is now settled before implementation: spike S1 runs codex once against `/dev/fd/3` with a named decision rule — A adopt, B take the final message from the `--json` event stream (already parsed at `lib/providers/codex.mjs:64-66`) at the cost of two documented error-string deltas, C stop and escalate rather than ship a codex-less multi-reviewer mode, since the feature's entire evidence base is a codex-vs-claude comparison. On the finding's other two channels: the Windows fallback is not a hole because §1.1 refuses N>1 on win32, so the branch that keeps a named spool provably has no peer, and that refusal now rests on one mechanism (unlink-of-an-open-file is unavailable) instead of two; the stderr and thrown-error channels the finding cites were already closed in the previous revision's §7(b)/§7(c) — raw provider text is quarantined in memory and dropped with a failed round, failure records carry a closed `reason` vocabulary plus `rejectedOutputSha256` instead of provider text, and the thrown error is orchestrator-constructed, so `cli.mjs:243-245` has nothing to emit and redirection is a non-issue rather than an operator warning. Tests move with the design: test 16 now asserts that no argv of any live child names a path under `os.tmpdir()` (the assertion that fails against today's adapter), test 27 asserts `os.tmpdir()` holds no entry at all once the fd is open, test 28 pins codex's result unreachable and its `data` unchanged, and tests 15/17 cover the failed-round re-run and redirected stderr.

## Your options

Only a human decides these. Each override is recorded with your reason and is auditable.

1. **The reviewer is wrong** — you accept the author's counter-evidence:
   ```
   plan-forge override --task concurrent-reviewers-atomic-round --finding <ID> --disposition withdrawn --reason "<why>"
   ```
2. **Real, but not blocking** — downgrade it; it stays open and on the record:
   ```
   plan-forge override --task concurrent-reviewers-atomic-round --finding <ID> --disposition severity_changed --severity minor --reason "<why>"
   ```
   Then `plan-forge resume --task concurrent-reviewers-atomic-round`.

A ruling settles a **finding**; it is not an approval and does not end the review. Once your rulings leave no
blocker, the author revises with them visible and the reviewer re-reviews — only a reviewer verdict of
`approved` finalizes the plan. Rule on some but not all of the blockers and the task stays stopped, so decide
every one below before you resume.

3. **Neither fits** — if the finding exposes a conflict in the *frozen requirement itself*, no override can
   express the fix. Requirements are immutable by design: amend the requirement and start a **new task id**.
   Deciding the design here and overriding the finding would approve a plan that still contains the defect.

---

# Concurrent Reviewers with Atomic Rounds

## Goal

Let a plan-forge task run **N reviewer slots (N≥1) concurrently and independently** against one plan in a single round, merge their findings into one finding map, and drive one author revision from the merged set. The purpose is coverage: two runs against one frozen requirement produced reviewer findings whose intersection was near zero, and the effective default reviewer (codex's built-in model, because the adapter passes `--ignore-user-config`) approved the same plan with zero findings. A single reviewer's verdict is a coin flip between "no defects" and "two majors".

The design holds four properties simultaneously:

1. **Independence is enforced, not requested.** Within a round, no byte derived from a slot's findings, raw output, or error text exists at any pathname another slot of that round can construct, discover, or **read out of the process table** — on the first pass or on any re-run. Where that is not achievable on a platform, multi-reviewer mode is refused rather than degraded (§7f). The exact boundary of the guarantee is stated in §11 rather than implied.
2. **The round is the atomic unit.** All N reviews commit in a single `rename(2)`, or nothing commits. A crash mid-round leaves the round re-runnable from clean.
3. **The audit chain survives.** Every review stays independently traceable (slot, provider, **frozen model**, prompt hash, `planSha256`, verdict), every finding is traceable to the reviewer that raised it, and the arbitration of every conflicting disposition is recorded.
4. **N=1 is unchanged.** A single-reviewer task commits exactly today's files with exactly today's bytes, sends exactly today's prompts, accepts exactly today's reviewer outputs, and reports exactly today's `status` JSON. Existing tasks (`task.reviewer: 'codex'`, `rounds/001/review.json`) resume with no migration. The one place this plan can be forced to touch N=1 is the *text* of two codex malfunction messages, and only under a named spike outcome — §7(e) states that exposure rather than hiding it, and §7(e)'s primary mechanism avoids it entirely.

Non-goals, per the frozen requirement: partial-round recovery; concurrent authors; LLM-based dedup; changes to the severity ladder; reviewer-to-reviewer debate.

### Scope reading: "changing provider adapters" as a non-goal

The requirement lists "Changing provider adapters or model resolution" as a non-goal. Read literally — no line of `lib/providers/*.mjs` may change — the feature is unbuildable: a multi-slot round needs one provider instance per slot, cancelling a peer needs the adapter to accept a signal, and §7(e) shows the codex adapter is itself the largest independence leak.

The Background makes the intended meaning explicit: partial recovery "cannot coexist with reviewer independence ... without changing the provider adapters", because reviewers "hold repository-wide read access (the codex adapter runs a read-only, not read-isolated, sandbox; the claude adapter grants unrestricted Read/Glob/Grep)". The non-goal is the adapters' **capability posture**: sandbox mode, granted tools, and which model is resolved.

This plan therefore treats as **in scope** mechanical adapter changes that do not alter what a provider may read or which model it runs: threading an `AbortSignal`, and changing **where plan-forge's own scratch bytes live and how it collects the provider's answer**. It treats as **out of scope**, and does not attempt, any change to `--sandbox`, `--tools`, `--permission-mode`, `--ignore-user-config`, or to `resolveModel`'s resolution rule (`lib/workflow.mjs:192-197`). Nothing in §7 grants or removes a provider capability. §1.2 adds a *validation* that a multi-slot roster resolved to a real model; it does not change how the model is resolved.

## Implementation

### 1. The reviewer roster

A **slot** is one reviewer configuration. Slots are identified by 1-based position: `R1`, `R2`, …. Position, not provider, is the identity, because two slots may legitimately share a provider with different models (`codex`+`gpt-5.6` vs `codex`+`gpt-5-mini` is the exact comparison the requirement's evidence is built on).

#### 1.1 `task.json`

The roster is **frozen at task creation**, like the requirement. Two forms exist, and `reviewerSlots(task)` in `lib/workflow.mjs` normalizes both:

```js
export function reviewerSlots(task) {
  if (Array.isArray(task.reviewers) && task.reviewers.length) {
    return task.reviewers.map((r, i) => ({
      id: `R${i + 1}`, index: i + 1,
      provider: r.provider, model: r.model,          // frozen, non-null — §1.2
      effort: r.effort ?? null, claudeMaxBudgetUsd: r.claudeMaxBudgetUsd ?? null
    }));
  }
  return [{
    id: 'R1', index: 1,
    provider: task.reviewer, model: task.reviewerModel ?? null,   // legacy: unresolved, may be null
    effort: task.reviewerEffort ?? null, claudeMaxBudgetUsd: task.claudeReviewerMaxBudgetUsd ?? null
  }];
}
```

- **N=1** (`initializeTask` with one reviewer): writes today's exact keys — `reviewer`, `reviewerModel`, `reviewerEffort`, `claudeReviewerMaxBudgetUsd` — and **no** `reviewers` key. `task.json` is byte-identical to today's.
- **N>1**: writes `reviewers: [{ provider, model, effort, claudeMaxBudgetUsd }, …]` and **omits** the four singular keys. A `reviewer: 'codex'` alongside a two-slot roster would be a lie in the audit record.
- **Legacy tasks** have no `reviewers` key and normalize to a one-slot roster. The legacy branch is not compatibility cruft that can rot: it is the mainline path for every N=1 task, exercised by most of the existing suite.

`loadContext`'s validation splits: today's `['claude','codex'].includes(task.reviewer)` becomes "**exactly one** of the two forms is present — `reviewers` present implies all four singular keys absent, and vice versa — and every slot's provider is `claude` or `codex`", failing with `task.json reviewer configuration is invalid`. That exclusivity is what §1.4 has to keep true.

**Platform gate.** A roster with more than one slot is refused on `win32`, at `initializeTask` and again as a pre-flight in `runWorkflow` (a `task.json` can be copied between machines): `multi-reviewer rounds are not supported on win32: reviewer output cannot be made unreadable to a concurrent peer`. The reason is mechanical and is argued in §7(f): the mechanism that makes a slot's scratch bytes nameless — unlinking a file while holding its descriptor — does not exist on Windows, and `/dev/fd` does not either. Refusing is the honest option: independence is the reason the feature exists, so a platform that cannot enforce it does not get a degraded version of it. **N=1 on Windows is untouched**, which is why this is a narrowing of a new capability rather than a regression. `package.json` declares no `os` restriction and keeps none.

`task.reviewerTimeoutMs` stays **round-level** (shared by all slots) — a round is bounded by its slowest slot, and a per-slot timeout would only add configuration surface.

The roster cannot change on resume. `resume --reviewer …` is rejected: changing the roster mid-task makes finding lineage across rounds incomparable (round 1's merged set came from a different jury than round 2's), and it would put two artifact layouts in one task's history.

#### 1.2 Frozen models are what make a frozen roster true (N>1)

A roster that pins positions but not models is not frozen. Today's task record freezes *effort* at creation (`resolveEffort` at `lib/workflow.mjs:542-543`) but stores the model **unresolved** (`reviewerModel: options.reviewerModel ?? null`, `lib/workflow.mjs:541`), and `buildRuntime` re-resolves it from the environment on **every** invocation (`cli.mjs:76-85` → `resolveModel`, `lib/workflow.mjs:192-197`, which falls back explicit → env var → `null`). Three consequences follow, and all three are unacceptable for N>1:

1. **The jury changes between rounds.** A task created with `PLAN_FORGE_CODEX_MODEL=gpt-5.6` and resumed from a shell without it silently reviews with codex's built-in default — by the Background's own evidence, the model that returns zero findings and approves. Slot identity is what §4.1 orders allocation by and §4.2 breaks ties on; if `R2` denotes a different model in round 2 than in round 1, that identity denotes nothing.
2. **The audit chain cannot recover what ran.** The codex adapter records `meta.model` from the configured value (`lib/providers/codex.mjs:69-76`), so a null model persists `model: null` and the actual model is unrecoverable from the artifact. (The claude adapter backfills from the response envelope — `model ?? envelope.model ?? primaryModelFromEnvelope(envelope)`, `lib/providers/claude.mjs:51` — so claude at least records what ran. Codex, the provider the whole evidence base is about, does not.) The requirement's constraint is that every review stays traceable to its **model**; for codex that is only true if we pin it.
3. **The roster's own duplicate check is defeated.** `--reviewer codex --reviewer codex` with no models is exactly the accidental case worth catching, and with null models the two slots are indistinguishable in the record.

> **Rule: every slot of an explicit roster (N>1) must resolve to a non-null model at task creation, and `initializeTask` persists the resolved string into the slot.**

- `initializeTask` calls `resolveModel(spec.provider, spec.model)` **once per slot**, at creation. A null result is an error, not a default: `reviewer slot R2 (codex) has no model; a multi-reviewer roster must pin every slot with --reviewer-model or PLAN_FORGE_CODEX_MODEL`. The env var name comes from the existing `PROVIDER_MODELS` table (`lib/workflow.mjs:61-64`).
- `buildRuntime` uses `slot.model` **verbatim** for roster slots and does **not** call `resolveModel`. That is the line that closes the drift: after creation, no environment variable can reach a reviewer's model again.
- The loader validates each wrapper's `meta.model` against its slot (§2). This is an integrity check that the configured model did not drift, not a claim about which weights ran — for codex, the configured value is all the adapter records, and changing that is model-resolution territory the requirement rules out.
- Effort is likewise resolved per slot at creation via `resolveEffort(provider, effort)`, matching what `initializeTask` already does for the singular keys.
- **N=1 keeps the legacy nullable behavior exactly**: `reviewerModel` is persisted unresolved, `buildRuntime` re-resolves it per run, and a null model still means "the CLI's built-in default". This is today's behavior, the existing tests pin it, and narrowing it would be a backward-compatibility break for every existing task. The asymmetry is deliberate and is the same one the plan applies everywhere: N=1 is frozen as-is, and the new capability carries the stricter rule.

#### 1.3 CLI

```text
--reviewer <claude|codex>                    # repeatable; each occurrence opens a slot
--reviewer-model <model>                     # slot-scoped
--reviewer-effort <effort>                   # slot-scoped
--claude-reviewer-max-budget-usd <amount>    # slot-scoped
--reviewer-timeout <seconds>                 # round-level (all slots)
```

`parseArgs` gains an ordered token list beside the existing last-wins `values` map: `{ command, values, tokens }`, where `tokens` is `[[key, value], …]` in argv order. Every existing option keeps reading `values`, so nothing else changes. Slot construction reads `tokens`:

- If **exactly one** `--reviewer` is given, slot-scoped flags bind to it **regardless of order** — this is today's behavior, and `--reviewer-model x --reviewer codex` must keep working for existing scripts.
- If **more than one** `--reviewer` is given, each slot-scoped flag binds to the **most recent preceding** `--reviewer`. A slot-scoped flag before the first `--reviewer` is an error: `--reviewer-model must follow the --reviewer it configures when several reviewers are given`.

`--allow-same-provider` keeps its meaning and now covers the roster: required if **any** slot's provider equals the author's.

Two slots with identical frozen `(provider, model, effort)` are **warned, not rejected**: `warning: reviewer slots R1 and R2 have identical provider/model/effort; they add cost without adding model diversity`. Sampling variance is a legitimate if weak strategy and the tool should not out-guess the operator. Note that §1.2 already converts the *accidental* case — `--reviewer codex --reviewer codex` with no models — from a silent purchase of two small-model runs into a hard error, so this warning now only fires on a deliberate, explicit duplicate.

No cap on N. Instead `run` logs the true worst case at init (content-free, and the direct answer to **Q4**):

```text
[stage] task initialized reviewerSlots=3 worstCaseReviewerCalls=72   # maxRounds × maxProviderFailures × N × PROVIDER_ATTEMPTS_PER_INVOKE
```

`buildRuntime` builds `providers.reviewers` — one adapter instance per slot, each with that slot's frozen model/effort/budget. `runWorkflow` normalizes `providers.reviewers ?? [providers.reviewer]`, so every existing test that passes `providers: { author, reviewer }` keeps working unmodified.

**Composition pre-flight.** Before any reviewer is spawned, `runWorkflow` asserts both the length **and the identity** of the injected providers: for every slot, `providers.reviewers[i].name === slots[i].provider`, failing with `reviewer provider for R2 is "claude" but the roster slot expects "codex"`. A length-only check lets swapped or misordered instances run the wrong configuration under each slot id and commit a `reviews.json` whose `meta.provider` disagrees with the roster — corruption that §2's loader would only catch on the *next* load, after the bad bytes are on disk and the spend is gone. Checking names before spawning turns that into a clean, re-runnable no-op. Both providers already expose a stable `name` (`lib/providers/codex.mjs:22`, `lib/providers/claude.mjs:14`), as do the test fakes (`test/helpers.mjs:29`), and every existing reviewer fake in `test/workflow.test.mjs` is `fakeProvider('codex', …)` against `initTask`'s `reviewer: 'codex'` — so the assert regresses nothing.

#### 1.4 Resume-time settings on a roster task

`updateTaskSettings` (`lib/workflow.mjs:755-774`) is the only writer of `task.json` after creation, and it is today unconditionally singular:

```js
const updated = {
  ...task,
  reviewerEffort: reviewerEffort ? resolveEffort(task.reviewer, reviewerEffort) : task.reviewerEffort ?? null
};
```

On a roster task this is wrong twice over, and both are reachable from a supported command (`cli.mjs:188-201` routes `--reviewer-timeout` and `--reviewer-effort` here):

- `resume --reviewer-timeout 1800` alone takes the `?? null` branch and **writes `reviewerEffort: null` onto a roster task**, injecting a singular key that §1.1's exclusivity rule forbids — the next `loadContext` then rejects `task.json` as invalid. A timeout change would brick the task.
- `resume --reviewer-effort high` calls `resolveEffort(task.reviewer, …)` with `task.reviewer` **undefined** on a roster task, which throws `unsupported provider undefined` (`lib/workflow.mjs:180-181`) — a confusing failure for a documented flag.

The roster-aware branch:

```js
const roster = Array.isArray(task.reviewers) && task.reviewers.length;
const updated = {
  ...task,
  authorTimeoutMs: authorTimeoutMs ?? task.authorTimeoutMs,
  reviewerTimeoutMs: reviewerTimeoutMs ?? task.reviewerTimeoutMs,
  authorEffort: authorEffort ? resolveEffort(task.author, authorEffort) : task.authorEffort ?? null
};
if (roster) {
  if (reviewerEffort) {
    updated.reviewers = task.reviewers.map((slot, i) => ({
      ...slot,
      effort: resolveEffortForSlot(`R${i + 1}`, slot.provider, reviewerEffort)
    }));
  }
} else {
  updated.reviewerEffort = reviewerEffort ? resolveEffort(task.reviewer, reviewerEffort) : task.reviewerEffort ?? null;
}
```

- **No singular key is ever introduced on a roster task**: the key is assigned only in the legacy branch, and `...task` cannot resurrect a key the roster form never had.
- **Effort is validated per slot**, as §1.1 promises: `resolveEffortForSlot` wraps `resolveEffort` and re-throws naming the slot — `invalid effort "max" for reviewer slot R2 (codex); valid values: …`. Because the whole `reviewers` array is built before `atomicWriteJson` runs, a single invalid slot aborts the update with `task.json` untouched; there is no half-applied roster.
- **Models are never touched here.** §1.2 freezes them at creation; this function has no path that could re-resolve one.
- **N=1 is byte-identical**: the legacy branch is today's expression, unchanged, and `test/workflow.test.mjs:265-285` passes unmodified.

### 2. Round artifacts and the atomic commit

`roundPaths` gains two entries:

```text
rounds/NNN/
├── author-output.json     # authoritative author source (unchanged)
├── plan.md                # projection (unchanged)
├── resolution.json        # projection (unchanged)
├── review.json            # roster size 1 — one wrapper, today's exact bytes
├── reviews.json           # roster size > 1 — all N wrappers, one file
├── merge.json             # roster size > 1 — derived arbitration projection
└── manifest.json          # audit summary
```

**The round's review artifact is one file, committed by one atomic rename.** Its name and shape are decided by the roster size:

- **N=1** → `review.json`, the single `{ meta, review }` wrapper. Already atomic today; it is its own commit marker. Nothing changes.
- **N>1** → `reviews.json`:

```json
{ "schemaVersion": 1, "round": 2, "reviews": [ { "meta": { "…": "…", "planSha256": "…", "slot": "R1" }, "review": { "…": "…" } }, { "…": "…" } ] }
```

This is deliberately *not* N separate files plus a commit marker. N files + marker is atomic **by protocol**: correctness then depends on a sweep of uncommitted files running before any peer spawns, and on that sweep being right forever. One file is atomic **by construction**: a crash cannot produce a partial `reviews.json`, and there is no half-committed state for the loader to reason about. Given that the requirement's central worry is exactly "half-written peer output readable on the re-run", atomic-by-construction is the right trade for one extra layout.

Consequently the line the requirement flags — `reviews.some((item) => item.meta.round === currentRound)` — **needs no change**. Presence of any wrapper for a round implies all N committed, because they arrived in one rename.

`meta.slot` is written **only when the roster has more than one slot**; readers default an absent `meta.slot` to `R1`. This keeps N=1 `review.json` byte-identical and makes legacy wrappers load through the same default.

Loader (`loadRoundArtifacts`) reads `files.review` when `slots.length === 1`, else `files.reviews`, and treats these as corruption:

- the artifact for the other layout exists (roster is frozen, so this can only be tampering or a hand-edit);
- `reviews.json` holds a count ≠ `slots.length`;
- slot ids are not exactly `R1..RN`, once each, in order;
- a wrapper's `meta.provider` disagrees with its roster slot's provider (a defence-in-depth backstop for §1.3's pre-flight, which is what actually prevents the condition from arising);
- **a wrapper's `meta.model` disagrees with its roster slot's frozen model** (N>1 only — §1.2). This is the check that makes the frozen roster verifiable after the fact rather than merely intended: an artifact whose model does not match the slot it is filed under is not a review of the jury `task.json` describes. For N=1 no such check exists, because the legacy model may legitimately be null and re-resolved.

Per-wrapper validation is otherwise unchanged: `schemas.validateReviewer(w.review)`, `w.meta.round === round`, `w.meta.planSha256 === sha256(plan)`. **`schemas/reviewer-output.schema.json` is not modified** — the per-reviewer wire contract is identical, which is what lets the models' prompts stay identical too.

Wrappers are appended to the existing flat `context.reviews`. New round-level accessors replace `lastReview` at its call sites:

```js
lastReviewedRound(context)          // max meta.round, or null
reviewsForRound(context, round)     // wrappers, slot order
roundVerdict(context, round)        // 'approved' iff every slot says 'approved'
roundCompletedAt(context, round)    // max meta.completedAt across slots
```

For N=1 each reduces to today's single-wrapper value, so `publishForHuman`'s `stoppedAt` header and `runWorkflow`'s finalize check produce identical bytes.

### 3. Splitting `normalizeReviewerOutput`

The three structural conflicts all live in one function because it does per-reviewer validation *and* round-level bookkeeping. Split them:

**Per-slot** (`validateSlotReview`) — everything checkable from the slot's own output plus the pre-round state, with no peer knowledge:

- the `missing`/`extra` disposition check against `activeFindings(before)` — **kept unchanged** (see §4.3);
- `explanation` non-empty; `severity_changed` requires `effectiveSeverity`;
- the redundant-`effectiveSeverity` coercion, unchanged, returning `coercions`;
- new-finding field presence, `id === null`, `relatedToFindingId`/`relationKind` **agreement** (both null, or both set with a valid kind);
- the **slot-local verdict self-check** (§4.4).

It does **not** allocate IDs, and it does **not** resolve `relatedToFindingId` to a target — that requires the round's allocation and belongs to the merge (§4.1).

**Round-level** (`mergeRoundReviews`) — runs once, single-threaded, after every slot has succeeded: ID allocation, relation resolution, disposition arbitration, and the round verdict.

`normalizeReviewerOutput` survives as the N=1 entry point, implemented on top of the general path:

```js
export function normalizeReviewerOutput(output, { round, priorReviews, overrides }) {
  const merged = mergeRoundReviews([output], { round, priorReviews, overrides, slots: [{ id: 'R1', index: 1 }] });
  return {
    normalized: merged.reviews[0], findings: merged.findings,
    requiredBefore: merged.requiredBefore, coercions: merged.coercions.map((c) => c.note)
  };
}
```

Every existing `findings.test.mjs` case passes unmodified, and N=1 is not a parallel code path that can drift — it is the general path with a one-element roster.

### 4. Merge semantics

#### 4.1 ID allocation and relation resolution (structural conflict 1 — AC2)

IDs are allocated **once, at merge time**, never inside a reviewer's validation. Concurrency is impossible because the merge runs after `Promise.allSettled` has resolved, in one turn of the event loop.

Order: **slot index ascending, then the reviewer's own `newFindings` array order**, assigning `F00N` upward from `nextFindingNumber(before)`.

- Race-free: one allocator, one caller.
- Deterministic: slot order comes from the frozen roster in `task.json`; within-slot order is the model's array order, preserved verbatim. Re-running a round from the same outputs yields the same IDs.
- For N=1 the sequence is identical to today's.

**Relation resolution.** Today `lib/findings.mjs:168-188` seeds `knownIds` from `before` and **grows it as each ID is assigned**, so a review's second new finding may legitimately set `relatedToFindingId` to the ID assigned to its own first new finding. That output is accepted today, and N=1 must keep accepting it. The merged rule preserves it exactly, scoped to the slot:

> `relatedToFindingId` must name a finding in `before`, **or** an ID allocated to an **earlier new finding of the same slot** in this round's allocation order.

- **N=1**: `before` ∪ its own earlier allocations *is* today's `knownIds`, evaluated in today's order. Same acceptances, same rejections, same `new finding relates to unknown id X` message. No behavior change.
- **N>1**: a slot emits `id: null` and cannot know the round's allocation, so a reference it guesses only validates if the guess lands on its *own* allocation. A cross-slot reference is rejected, which is what prevents a coincidental `F001` guess from forging a `recurrence` link into a peer's finding and inheriting the peer's `criticalReviewStreak`.

The anti-forgery property is therefore kept without a backward-compatibility break. `applyRoundToMap` (§5) resolves same-round ancestors from the map in the same order, which is exactly what `applyReviewToMap` does today at `lib/findings.mjs:44`.

#### 4.2 Disposition arbitration (structural conflict 3 — AC3, **Q1**)

Every slot dispositions every active finding, so each finding carries N dispositions. Map each to an openness state:

| disposition | state |
| --- | --- |
| `resolved` | `CLOSED` |
| `withdrawn` | `CLOSED` |
| `still_open` | `OPEN(current effective severity)` |
| `severity_changed(s)` | `OPEN(s)` |

Total order: `CLOSED < OPEN(nit) < OPEN(minor) < OPEN(major) < OPEN(blocker)`.

**The rule: the maximum wins. Ties break to the lowest slot index.** The winning disposition's `status`, `effectiveSeverity`, and `explanation` are applied exactly as a single review's disposition is applied today — including the `criticalReviewStreak` update, which now happens **once per round**, not once per review.

`current effective severity` is read from the fold state before this round. Because `collectFindings` applies human overrides once, *after* the whole fold (`lib/findings.mjs:81`), that state is override-free — so arbitration is a pure function of the review artifacts and never churns when an override lands later. For a finding a human has ruled on, `applyOverrides` still dominates the final state, exactly as today; arbitration then only decides which reviewer's `lastExplanation` is carried into the brief.

**Why max-openness, and why not the alternatives.**

*Why not majority vote.* This is the decisive argument. The feature exists because the union of findings beats any single reviewer: Claude found three defects, gpt-5.6-sol found two of those plus one Claude missed, gpt-5-mini found nothing and approved. Under majority vote, a roster of two mini-class reviewers plus one strong one discards every finding the strong one raises. Any rule that lets reviewers cancel each other out re-introduces exactly the variance this change was built to remove, and it does so *silently*.

*Asymmetry of error costs.* A false-open costs one revision round; the author answers it with `rejected` plus repository evidence, and the reviewer that raised it can `withdraw` next round. A false-closed ships a plan with a real defect — the one outcome the gate exists to prevent. The conservative direction is the cheap direction.

*Why not "any `still_open` wins" flat.* This was the requirement's stated conservative default, and it is subtly wrong: if F001 is a `minor`, R1 says `still_open` and R2 says `severity_changed → blocker`, a flat rule discards R2's **upgrade** and clears the gate. Max-openness keeps it. Severity-awareness is not a refinement here; it is required for correctness.

*Does one weak reviewer stall every round indefinitely?* No, and the bound already exists. A finding stays open only while some slot keeps saying `still_open`; `hasStalledCriticalFinding` fires at `criticalReviewStreak >= 2` (`lib/findings.mjs:109-113`), so a lone hold-out costs exactly two re-reviews and then hands to a human, who withdraws it with `plan-forge override --disposition withdrawn`. The `recurrence` inheritance means re-filing under a fresh ID does not reset the counter. Note the direction of the risk, too: the *weak* reviewer in the observed evidence approves everything, i.e. votes `resolved` — which max-openness correctly ignores. The stall risk belongs to an over-strict reviewer, which is rarer and already bounded. `merge.json` (§9) names which slot is holding out, so the human ruling is informed rather than blind.

#### 4.3 Why every slot must still disposition every active finding

The requirement notes the `missing`/`extra` check as a structural conflict. The resolution is that the check is **already per-slot and needs no change**: the active set derives from *prior* rounds, so a slot can satisfy it with zero peer knowledge. Keeping the obligation is what makes arbitration well-defined — abstention has no defined openness state, and permitting it would let a lazy reviewer opt out of the exact findings it least wants to think about. Only the *conflict* rule is new.

#### 4.4 Verdict composition (structural conflict 2 — AC4)

**Per slot**, the verdict is checked against **that slot's own view**: `before` + its own dispositions + its own new findings (given provisional IDs from `nextFindingNumber(before)`, scoped to the check and discarded afterwards):

```js
const after = collectFindings([...priorReviews, { meta: { round }, review: { previousFindings, newFindings: provisional, summary: '', verdict: 'changes_requested' } }], overrides);
const expected = blockingFindings(after).length ? 'changes_requested' : 'approved';
```

A reviewer that files a blocker and votes `approved` is incoherent about its **own** output, and that is invalid regardless of peers — so the integrity check the requirement flagged is not lost, it is relocated to the only frame in which a concurrent reviewer can be held to it. The check stays an equality, exactly as today (`lib/findings.mjs:196-200`): a slot whose own view has no blocking finding **must** vote `approved`, even when a peer is about to file a blocker, because it cannot see the peer and must not be asked to. For N=1 the slot-local view *is* the merged view, so this is today's computation and today's error message, verbatim.

**Per round**: `verdict = 'approved'` iff **every** slot voted `approved`.

This composition is not an arbitrary choice — it is forced. Under max-openness arbitration:

- If slot *i*'s view has F blocking, slot *i*'s disposition yields `OPEN(critical)`, and the merged max is ≥ that, so F blocks in the merge.
- If F blocks in the merge, the max was achieved by some slot *j*, whose own view therefore has F blocking.
- New findings from every slot appear in the merge unchanged.

So **merged blocking set = ∪ (per-slot blocking sets)**, up to the merge's own renaming of each slot's provisional new-finding IDs, and therefore "every slot approved" ⟺ "the merged blocking set is empty". The AND rule *is* the gate recomputed from the merged map; they cannot disagree. (The one skew: a human `severity_changed` override is visible to the slot-local check but not to the override-free fold. It does not matter, because the override dominates the final state either way, and `runWorkflow` reads the *stored* round verdict rather than recomputing the gate — deliberately, so that a ruling buys one more round instead of minting an approval. That existing invariant is preserved verbatim.)

`runWorkflow`'s `review.review.verdict === 'approved'` becomes `roundVerdict(context, round) === 'approved'`.

### 5. `collectFindings` becomes round-aware (AC5)

```js
export function collectFindings(reviewWrappers, overrides = { entries: [] }) {
  const map = new Map();
  const byRound = groupBy(reviewWrappers, (w) => w.meta.round);
  for (const round of [...byRound.keys()].sort((a, b) => a - b)) {
    applyRoundToMap(map, byRound.get(round).sort(bySlotIndex), round);
  }
  applyOverrides(map, overrides);
  return map;
}
```

`applyRoundToMap(map, wrappers, round)`:

1. Gather each active finding's dispositions across wrappers, validating references (`review references unknown finding X` — unchanged).
2. Arbitrate per §4.2 and apply the winner **once**, so `criticalReviewStreak` increments once per round. Attach `dispositions: [{ slot, status, effectiveSeverity, explanation }]` (all of them) to the in-memory finding for human-facing surfaces.
3. Apply new findings, slot order then array order, reading the IDs already persisted in each wrapper and attaching `raisedBy: slotId`. Same-round `recurrence` ancestors resolve from the map exactly as today (`lib/findings.mjs:44`). The `duplicate finding id` guard stays as a persistence-integrity check — the merge guarantees uniqueness, so a duplicate on disk means corruption.

For N=1, a round is one wrapper, arbitration is the identity, and this is today's `applyReviewToMap` unchanged.

The in-memory `dispositions` and `raisedBy` fields are **not** exposed to models: `sanitizedFinding` and `closedFindingHistory` pick fields explicitly and are not touched, so both prompts stay byte-identical (see §7g).

### 6. Concurrent execution, cancellation, and round failure

```js
const slots = reviewerSlots(context.task);
assertPlatformSupportsRoster(slots);               // §1.1 win32 gate
assertProvidersMatchRoster(slots, reviewerProviders); // §1.3 name pre-flight
const prompt = buildReviewerPrompt({ … });         // ONE prompt, identical for every slot
const startedAt = now();
const sink = slots.length > 1 ? logger.quarantine() : logger;
const controller = new AbortController();

const settled = await Promise.allSettled(slots.map((slot, i) =>
  invokeWithLimit({
    role: 'reviewer', phase: 'reviewing', round: currentRound, slot: slot.id,
    provider: reviewerProviders[i], prompt, schema, schemaFile,
    timeoutMs: context.task.reviewerTimeoutMs, signal: controller.signal,
    logger, stderrSink: sink,
    validate(data) { normalized[i] = validateSlotReview(data, { round, before, priorReviews, overrides }); }
  }).catch((error) => { controller.abort(); throw error; })
));
```

`Promise.allSettled`, not `Promise.all`: every subprocess must be awaited so none is orphaned, and every slot's outcome must be recorded. Cancellation is cooperative — the first **final** failure (after `invokeWithLimit`'s retries, so a transient blip does not kill healthy peers) aborts the rest, which saves the in-flight spend that the re-run would otherwise duplicate.

`invokeWithLimit`'s retry loop (`lib/workflow.mjs:238`) keeps its shape, but the literal `2` becomes an exported named constant:

```js
export const PROVIDER_ATTEMPTS_PER_INVOKE = 2;   // one retry per invocation
for (let attempt = 1; attempt <= PROVIDER_ATTEMPTS_PER_INVOKE; attempt += 1) { … }
```

This is the multiplier the Q4 bound must be expressed in (§10), so it must exist in exactly one place rather than as a duplicated `2` in the loop and in a comment.

`runProcess` gains `signal`: on abort it takes the same process-group kill path as a timeout and resolves with `aborted: true`. `processFailure` returns `ProviderError(…, { aborted: true, retryable: false })` for that case, so `invokeWithLimit` never retries an abort. This is the mechanical process change justified in *Goal*: it changes nothing about what a provider may read.

**All slots succeeded** → `mergeRoundReviews` → build N wrappers → `commitRoundReviews` (one rename) → `writeMergeProjection` → `sink.flush()` → log the coercion notes and `review committed` → reload context → `writeManifest`.

Nothing peer-derived is logged from inside `validate`; coercion notes travel back in the merge result and are logged only after the commit.

**Any slot failed** → `handleRoundFailure`. Exactly **one** failure record is written for the round:

```json
{
  "schemaVersion": 1, "sequence": 1, "occurredAt": "…", "kind": "failure",
  "round": 2, "phase": "reviewing", "phaseKey": "reviewing:002",
  "provider": null, "errorClass": "invalid_output", "attempts": 1,
  "message": "reviewer round failed: 1 of 2 slots failed",
  "rejectedOutput": null,
  "slots": [
    { "slot": "R1", "provider": "codex",  "outcome": "ok" },
    { "slot": "R2", "provider": "claude", "outcome": "failed",  "errorClass": "invalid_output", "reason": "output_rejected", "attempts": 1, "rejectedOutputSha256": "…" },
    { "slot": "R3", "provider": "codex",  "outcome": "aborted", "errorClass": "provider_error", "reason": "aborted", "attempts": 1, "rejectedOutputSha256": null }
  ]
}
```

**The round is the unit of failure.** This is not cosmetic: `failureCount` counts records per `phaseKey` (`lib/workflow.mjs:396-404`), so per-slot records would push a 3-slot round straight past `maxProviderFailures: 2` on its first hiccup. One record per round keeps `maxProviderFailures` meaning exactly what it means today.

The record's aggregate `errorClass` is the lowest-index failing slot's class — deterministic and informative. `state.errorClass` follows it. The rest of `handlePhaseFailure`'s tail (count → `failed` vs `needs_human` → `writeState` → throw, `lib/workflow.mjs:425-430`) is factored out and shared, and **N=1 keeps calling `handlePhaseFailure` unchanged**, so its failure record keeps its verbatim `message` and full `rejectedOutput`.

The error thrown for a failed N>1 round is **content-free by construction** — see §7(c). N=1's thrown error is unchanged.

### 7. Enforcing independence

The threat model is precise, and it is not an attacker: it is a reviewer agent with repository-wide read access, doing its job, that finds a peer's output lying somewhere readable and anchors on it. The requirement makes it a hard constraint anyway — first pass and re-run alike — so the design must make the bytes unreachable rather than merely unlikely to be noticed.

**Two channels an earlier draft of this plan got wrong, and what they teach:**

1. **argv is public.** `lib/providers/codex.mjs:36` passes `--output-last-message <path>` on the **command line**. The codex sandbox is `--sandbox read-only`, which restricts *writes*, not process execution — so a peer codex slot can run `ps` and read its peer's full argv, including that path. This defeats *every* design whose secret is a filename: an unlistable directory and a 128-bit random name are worthless when the name is published in the process table. A mechanism is only sound if there is **no name to publish**.
2. **A mode bit is not ours to rely on.** Both slots run as the *same uid*, so the owner of a `0300` directory is also the peer; `chmod` restores enumeration. The only thing standing in the way is the provider CLI's own sandbox, which this project neither owns nor may change. `docs/plans/needs_human/concurrent-reviewers-v2.md:100` states the rule this project already accepted for exactly this reason: *"An independence constraint that holds only while a third-party CLI's sandbox happens to deny `chmod` is the same species of claim as 'we asked the model not to look' — the claim F001 already rejected, wearing a mode bit."*

**The property this section delivers:** *at no point during a round does any byte derived from a slot's findings, raw output, or error text exist at a pathname another slot can construct, discover, or read out of the process table.* The mechanism is **namelessness**, not obscurity: the bytes live in files that have no directory entry, held open by descriptors the peer's own `/dev/fd` cannot reach. Everything below is one channel closed against that property. §11 states, in the same terms, what the property does **not** cover and why that is out of reach.

**(a) Reviews.** Held in memory until all N succeed; committed in one rename after the last slot exits (§2). On failure they are dropped. There is no file to read, so path secrecy is not relied on.

**(b) `failures/`.** The requirement names this leak explicitly. For N>1, the round failure record carries **no free text derived from provider output**:

- `rejectedOutput: null`, replaced by `rejectedOutputSha256` — enough to prove in the audit chain that *something* was rejected and to match it against a reproduction, and it leaks nothing usable.
- No slot `message`. Instead a closed vocabulary `reason`, set at construction by the code that *knows* whether provider text is embedded: `timeout`, `output_overflow`, `exit_<code>`, `signal_<name>`, `invalid_json`, `missing_output`, `missing_structured_output`, `spawn_error`, `output_rejected`, `aborted`.

This precision matters. `processFailure`'s message is `${provider} failed: ${summary}` where `summary` is the last 1200 bytes of **stdout+stderr** (`lib/process.mjs:157-161`) — and codex's `--json` stdout is an event stream that can carry the agent's own messages. So "keep transport errors verbatim, redact only validation errors" would be wrong. The rule is instead: **a message is verbatim only when the orchestrator constructed it without embedding provider output.** `ProviderError` gains a `safeReason` field set by `processFailure` (`timeout`/`output_overflow`/`exit_*` — all built from `details`, never from text) and by each adapter's own error paths; a plain `Error` from validation carries none and maps to `output_rejected`.

`errorClass`, `attempts`, `outcome`, `provider`, and `slot` are content-free and are recorded. `outcome: 'ok'` is worth keeping: it tells the human which slots will be re-billed, and it is schedule metadata already implied by `task.json`.

**(c) `run.log` and the terminal.** `createTaskLogger`'s `write` sends every line to **both** the `stderr` sink and `run.log` (`lib/logger.mjs:13-27`), and `run.log` is inside the repository. `logger.providerStderr` therefore mirrors raw provider stderr into a file every reviewer can read.

For **N>1**, raw provider text reaches neither destination until the round commits:

- `createTaskLogger` gains `quarantine()`, a view whose `providerStderr` **buffers** the formatted lines in memory and writes them nowhere, plus `flush()` (append the buffer to `run.log`) and `drop()` (discard, then emit one content-free line: `quarantined reviewer stderr discarded with the failed round`). `flush()` runs only after the commit, i.e. after every slot of the round has exited; a *later* round's reviewer reading it is not a same-round peer, and prior rounds' reviews are legitimately readable anyway. `NOOP_LOGGER` gains no-op equivalents.
- The error thrown by `handleRoundFailure` is built from the closed `reason` vocabulary and carries no provider text, so `cli.mjs:243-245`'s `process.stderr.write(\`plan-forge: ${error.message}\`)` cannot emit any either. This is what makes the redirection hazard go away: it is no longer advice to the operator, because there is nothing sensitive on the channel to redirect. `cli.mjs:236` already logs only `errorClass`.

Raw provider stderr for N>1 is therefore **not streamed live at all**, not even to a terminal. Live progress remains fully visible through the content-free lines — stage, heartbeat, and error records carrying `phase`, `round`, `slot`, `provider`, `attempt`, `elapsedSeconds`, `pid`, `errorClass` — which is what a watching operator actually reads. The cost is real and bounded: when a multi-reviewer slot fails, the raw output is gone. The escape hatch is exact and needs no new machinery — **reproduce the failing slot as a one-slot roster**, where there is no peer, nothing is quarantined, and today's full `rejectedOutput` and verbatim message are retained. Trading a debugging convenience for the constraint the feature exists to uphold is the same trade the requirement's human ruling already made for recovery efficiency.

**For N=1 the quarantine is not constructed at all**, so `run.log` interleaving, thrown-error text, and live stderr are exactly as today.

**(d) Orphaned temp files in the repository.** `atomicWriteFile` writes `.<name>.<pid>.<uuid>.tmp` then renames, unlinking on error. A hard kill *during* the `reviews.json` write leaves a temp file holding all N reviews inside the round directory — readable on the re-run. So `loadRoundArtifacts` with `repair: true` sweeps `.*.tmp` from the task and round directories before returning, and therefore before any provider is spawned. This is safe because the task lock excludes concurrent writers, and `inspectTask` (`repair: false`, no lock) never sweeps. It also fixes pre-existing litter.

**(e) Provider scratch outside the repository: nameless files.** Two channels write peer-derived bytes into `os.tmpdir()`, which every reviewer can list:

1. **codex's `--output-last-message` file.** `lib/providers/codex.mjs:24-36` creates `/tmp/plan-forge-codex-<mkdtemp>/last-message.json`; the adapter reads it only after the subprocess exits (`:51-63`) and removes it in the `finally` (`:79-80`). Between codex's write and the adapter's read, a concurrent peer needs nothing but the fixed glob `/tmp/plan-forge-codex-*/last-message.json` — or, per the argv channel above, one `ps` — to read a completed slot's **entire structured review**.
2. **The subprocess stdout spool.** `lib/process.mjs:43-44` opens `os.tmpdir()/plan-forge-stdout-<pid>-<uuid>.log` and deletes it only in `collectStdout` (`:60`). For codex, stdout is a JSONL event stream written *throughout* the run, so this window is minutes long, not milliseconds.

Both are closed by one primitive in `lib/process.mjs` — a file that has **no name for the entire life of the run**:

```js
// Every step is synchronous and finishes before any child is spawned, so the
// only instant a directory entry exists is inside this function, in a directory
// that denies enumeration, on a file that is still empty. After it returns there
// is no path — not in argv, not in a glob, not in a readdir — only a descriptor.
// A SIGKILL frees the inode with the fd: nothing to clean up, nothing to leak.
export function openNamelessTempFd(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.chmodSync(dir, 0o300);                     // belt-and-braces only; see below
  const file = path.join(dir, `${crypto.randomUUID()}.tmp`);
  const fd = fs.openSync(file, 'wx+', 0o600);   // read/write: collection reads this fd (§7e2)
  fs.unlinkSync(file);
  fs.rmdirSync(dir);                            // rmdir(2) needs no read permission on the target
  return fd;
}
```

The `0300` chmod is **not load-bearing** and nothing in this plan's claim rests on it — per the rule quoted above, a same-uid peer could chmod it back if its sandbox let it. It closes exactly one thing: a peer spinning on `readdir('/tmp')` during the few microseconds between `mkdtemp` and `rmdir`. The claim rests on the `unlink`.

- **The stdout spool** is such an fd. `runProcess` passes it as `stdio: ['pipe', fd, 'pipe']` and the child inherits it by descriptor, not by path. There is no name at any point after `openNamelessTempFd` returns, and the spool is created *before* `spawn`, so no peer can open it at any instant of the run. This is a strict improvement for N=1 too: today a hard kill leaks the spool into `/tmp` permanently.

- **Collection (F009).** The old `collectStdout` closed the fd and re-opened the **pathname** (`lib/process.mjs:45-61`) — which no longer exists — and the fd was opened `'w'`, write-only. Both must change, and the read must be **positional**: the child inherits our descriptor, so it shares the open file description and leaves the offset at EOF; a plain `readFileSync(fd)` or `read()` would return zero bytes and silently blank out every provider response. So:

  ```js
  const collectStdout = () => {
    if (stdoutFd === null) return '';
    try {
      const size = fs.fstatSync(stdoutFd).size;            // no path to stat
      if (size > maxBuffer) { overflow = true; return ''; } // today's overflow contract
      const buffer = Buffer.allocUnsafe(size);
      let read = 0;
      while (read < size) {
        const n = fs.readSync(stdoutFd, buffer, read, size - read, read);  // position, never the offset
        if (n === 0) break;
        read += n;
      }
      return buffer.subarray(0, read).toString('utf8');
    } catch {
      return '';
    } finally {
      try { fs.closeSync(stdoutFd); } catch { /* already closed */ }
      stdoutFd = null;
    }
  };
  ```

  The loop is not decoration: `readSync` may return short for large reads, and the whole reason the spool exists is the `lib/process.mjs:38-42` guarantee that large JSON envelopes are never truncated. Both `child.on('error')` and `child.on('close')` call this exactly once, as today; the `stdoutFd === null` guard preserves that.

- **codex's structured result** takes the same fd, passed by descriptor. The adapter opens a second nameless fd, hands it to `runProcess` as `extraFds: [outFd]` (so the child sees it as fd 3), and passes **`--output-last-message /dev/fd/3`**. What appears in argv is then `/dev/fd/3`, which is not a name at all: in a peer's process `/dev/fd/3` resolves to *the peer's own* descriptor 3. The adapter reads the result positionally from `outFd` (same discipline, same reason: codex may share our offset or open a fresh description, and reading from position 0 is correct either way), then closes it. No temp directory, no glob target, no guessable name, and nothing to `rm` in a `finally`.

*The one external assumption, and the spike that settles it.* codex must accept `/dev/fd/3` as its `--output-last-message` target. It has every reason to — it is an absolute path it opens for writing, and the current path already works from the same process — but it is an external CLI, so **spike S1** (below) confirms it before a line is written. S1's decision rule, in order:

- **S1-A (primary): `/dev/fd/3` works.** Adopt. The adapter's contract, its two error strings, and its `data` are all unchanged, so **N=1 stays byte-identical including failure text**, and the mechanism applies unconditionally rather than forking the adapter by roster size.
- **S1-B (fallback): it does not, but the `--json` event stream carries the final structured message.** Drop `--output-last-message` entirely and take the result from the stream, which is already parsed for `turn.completed` and `thread.started` (`lib/providers/codex.mjs:64-66`) and already lands in the nameless spool. This is equally nameless. Its cost is named honestly: two codex **malfunction** messages change text (`codex did not produce output-last-message: …` → `codex produced no final message`; the `invalid JSON` path keeps its shape). `errorClass`, `incomplete: true`, retry behavior, and every committed artifact are unchanged; the delta is confined to `failures/*.json` message text on a codex malfunction, and `test/providers.test.mjs` moves with it. That is the sole exception to *Goal* property 4, it exists only on this branch, and it is written here rather than discovered in review.
- **S1-C: neither works.** The approach is not implementable as designed. **Stop and escalate to a human with S1's evidence** rather than shipping a codex-less multi-reviewer mode: the entire evidence base for this feature is a codex-vs-claude comparison, so a roster that cannot contain a codex slot is not a smaller version of the feature, it is a different one.

**(f) Platform.** Namelessness is POSIX: on `win32` an open file cannot be unlinked and `/dev/fd` does not exist, so neither channel in (e) can be closed and §1.1 **refuses a roster of more than one slot on win32**. On win32 both the spool and the codex output file keep today's named-path behavior (open, collect by path, `rm`) — which is not a hole, because on the only platform that takes that branch there is provably no peer. `lib/process.mjs` already special-cases win32 for `detached` and `kill()`, so the platform fork is not a new concept in this file.

**(g) Prompts.** Identical for every slot; see the **Q3** answer in §10.

### 8. Recovery

The recovery table gains one row and one clarification:

| Current valid artifacts | Next action |
| --- | --- |
| `author-output.json` + projections valid; no round review artifact | Invoke **all N** reviewer slots concurrently |
| Round review artifact present | The round committed in full; never re-invoke any slot |

There is no third state. A crash at any point during a round leaves no review artifact, so resume re-runs **the entire round** — never a subset. That is AC6, and it is a property of the file layout rather than of a recovery rule that could be got wrong.

### 9. Human-facing surfaces

**`merge.json`** (N>1 only; a derived projection, re-derived idempotently by `writeIfChanged` during reconcile when `repair: true`):

```json
{
  "schemaVersion": 1, "round": 2, "planSha256": "…", "verdict": "changes_requested",
  "reviewers": [
    { "slot": "R1", "provider": "codex",  "model": "gpt-5.6",         "promptSha256": "…", "verdict": "approved" },
    { "slot": "R2", "provider": "claude", "model": "claude-opus-4-8", "promptSha256": "…", "verdict": "changes_requested" }
  ],
  "newFindings": [ { "id": "F003", "raisedBy": "R2", "severity": "blocker", "planSection": "Implementation" } ],
  "dispositions": [
    { "id": "F001", "conflict": true,
      "arbitrated": { "slot": "R2", "status": "still_open", "effectiveSeverity": null },
      "bySlot": [ { "slot": "R1", "status": "resolved", "effectiveSeverity": null },
                  { "slot": "R2", "status": "still_open", "effectiveSeverity": null } ] }
  ]
}
```

The `model` per reviewer is the frozen roster value (§1.2), so this file names the jury that actually sat. Dispositions are recorded in **wire shape** — `effectiveSeverity` only where the reviewer set it — never as resolved severities, so the file is a pure function of the review artifacts and is stable forever. The identical `promptSha256` across slots is machine-checkable evidence that the jury saw the same input.

**`manifest.json`** — `reviewSha256` keeps its meaning ("sha256 of the round's committed review artifact") for both layouts. N=1 keeps `reviewerMeta` and is byte-identical; N>1 replaces it with `reviewers: [{ slot, reviewSha256: sha256(jsonText(wrapper)), meta }]`, keeping every review independently traceable and tamper-evident inside the single file.

**`approval.json`** — `reviewSha256` likewise binds the whole round artifact. `gate.verdict` is the composed verdict; for N>1, `gate.reviewerVerdicts: [{ slot, provider, model, verdict }]` expresses the multiple reviews. `expectedApprovalFields` changes only in which file it hashes. N=1 is byte-identical.

**Published headers** — `reviewer=` keeps its key. `reviewersLabel(task)` yields `codex` for N=1 (byte-identical) and `codex+claude` (providers, slot order) for N>1; per-slot models live in `manifest.json` and `merge.json`.

**Decision brief** — for N>1 each blocking finding gains a `Raised by` line and, where the slots disagreed, every slot's position, not just the winner's:

```text
**Raised by** R2 (claude / claude-opus-4-8)
**Reviewer positions** (round 2)
- R1 `resolved` — the fix looked right
- R2 `still_open` — the guard still runs after the write   ← arbitrated
```

Which reviewer is holding out is the single most decision-relevant fact for a human ruling on a conflicted finding. For **N=1 the lines are omitted** — attribution is already in the header, so the brief stays byte-identical.

**`status`** — `inspectTask` keys its output on the roster size. For a **one-slot roster it emits today's exact object**, field for field, as enumerated at `lib/workflow.mjs:715-729`; `raisedBy` and `dispositions` appear on `blockingFindings[]` **only when the roster has more than one slot**, where no pre-existing consumer can be reading them because no such task can pre-exist this change. The gate is the same `slots.length === 1` test that already selects the artifact layout (§2), the wrapper shape (§2), the brief (above), and the quarantine (§7c) — one condition, applied consistently, rather than a special case for this surface.

An earlier draft argued that `status` was a read-only diagnostic and could afford additive fields. That reasoning does not survive the requirement: it grants no exception for diagnostic surfaces, `status` is the agent-facing contract that the SKILL workflow reads, and an additive field is exactly the kind of change a strict consumer rejects. The cost of conforming is one conditional.

### 10. Answers to the open design questions

**Q1 — which disposition wins?** Max-openness with severity, ties to the lowest slot index. Argued in §4.2: majority vote destroys the feature's premise; a flat `still_open` rule silently discards upgrades; the false-open/false-closed cost asymmetry favours conservatism; and the "weak reviewer stalls forever" worry is already bounded by `criticalReviewStreak >= 2` → `needs_human` → human override, with `merge.json` naming the hold-out.

**Q2 — merge duplicates across reviewers? No.**

1. *The cost of not merging is bounded and small.* The observed intersection is near zero, so duplicates are rare. When one occurs, the author fixes the defect once and writes two resolutions (a sentence each); each reviewer then closes its own.
2. *The cost of merging wrongly is unbounded.* Merging needs semantic-equivalence judgment. §7 of `docs/design.md` already refuses this for `relatedToFindingId` — "neither can be judged mechanically and reliably by the orchestrator" — and LLM-based dedup is an explicit non-goal. Merging two findings that are *not* the same defect silently deletes a real one: the exact outcome the gate exists to prevent, arriving through the machinery meant to strengthen it.
3. *Merging would destroy the evidence for the feature.* AC5 wants every finding traceable to one reviewer. A merged finding has two parents and one `raisedBy`. Keeping them separate preserves the 1:1 map and lets anyone *measure* the intersection from `merge.json` — the very metric that motivated this change.
4. *It would corrupt the stall detector.* Two duplicates each carry a `criticalReviewStreak`; merging them would require merging counters, with no defensible rule.
5. *The escape hatch already exists and is audited.* `merge.json` lists `raisedBy` per finding, so a human sees duplicates at a glance and rules with `plan-forge override --finding F007 --disposition withdrawn --reason "duplicate of F003"`. Human-adjudicated dedup, no new machinery, on the record.

**Q3 — tell the reviewer it is one of several? No.** The reviewer prompt is byte-identical regardless of N; `prompts/reviewer.md` is not modified.

1. *Diffusion of responsibility is the risk, and it is the failure mode already in evidence.* The prompt spends a whole section on "Approval is a conclusion, not a default" and demands the reviewer state which `file:line` it verified — precisely because a reviewer that skips verification is the observed failure (gpt-5-mini: zero findings, approved). "Another reviewer is also checking this" hands that reviewer a rationale for the skip.
2. *There is nothing actionable it could do with the information.* Coordination is a non-goal. Every instruction we would attach to the disclosure ("review as if you were the only reviewer") is already the prompt's content. The information is inert at best.
3. *Identical prompts buy a real audit property.* All slots in a round share one `promptSha256`, which is machine-checkable evidence that they got the same input — recorded in `merge.json`. Personalizing the prompt would trade that away for nothing.
4. *It preserves the experiment.* The premise is that variance across models is large. That is only measurable if the input is held constant; otherwise a difference between slots is unattributable.

Counter-argument, acknowledged: a reviewer told it is one of N might recalibrate — suppressing borderline findings (diffusion, a harm) or inflating them knowing merge is a union (also a harm). Silence is the neutral choice.

Honest limit: this is "we do not tell it", not "it cannot know". Nothing points a reviewer at `.plan-forge/`, but a reviewer that goes looking finds the roster in `task.json` and prior rounds' `reviews.json`. Preventing that needs sandbox read-isolation — the non-goal the requirement already ruled on (§11). The claim is scoped accordingly.

**Q4 — what bounds the worst case, and where is it enforced?**

The bound is **`maxProviderFailures` (default 2), enforced in `failureStatus`/`handleRoundFailure`, keyed on `phaseKey = "reviewing:NNN"`.**

It is *not* `max-rounds`, and the requirement's phrasing ("re-running the round until `max-rounds`") points at exactly the misconception worth naming: a failed round **never advances the round counter** — no review commits, so `currentRound` is unchanged. `max-rounds` can therefore never fire on a flaky slot, and a design that leaned on it would spin forever.

The bound must be stated in **billable provider calls**, not round attempts, because two multipliers sit between them:

```text
worstCaseReviewerCalls = maxRounds × maxProviderFailures × N × PROVIDER_ATTEMPTS_PER_INVOKE
```

- `maxProviderFailures` (default 2) — round-level failure records per `phaseKey`, counted at `lib/workflow.mjs:396-411`, latched at `:426`.
- `PROVIDER_ATTEMPTS_PER_INVOKE` (2) — the retry **inside** each slot's `invokeWithLimit` (`lib/workflow.mjs:238`), which calls the provider once per attempt (`:244-265`) and only records the *final* outer failure (`:413-425`). A persistently **retryable** failure — a timeout, an overload, anything `TRANSIENT` matches at `lib/process.mjs:155,163` — therefore bills two calls per slot per round attempt while producing one failure record. The reviewer role gets no other retry: the `authorOutputRetry` branch at `:278` is author-only, so a persistently **non-retryable** failure bills one call per slot per round attempt.

An earlier draft's `maxRounds × maxProviderFailures × N` was the non-retryable case advertised as the worst case, understating a flaky slot by 2×. `PROVIDER_ATTEMPTS_PER_INVOKE` is exported and used by the `worstCaseReviewerCalls` log line, so the number the operator is shown and the loop that spends the money cannot drift apart.

- Worst case for one round: `maxProviderFailures × N × PROVIDER_ATTEMPTS_PER_INVOKE` calls, then the task latches to `needs_human` with `errorClass: 'provider_failure_limit'` and stops spending. Defaults, N=3: 12 calls.
- Worst case for a task: the full product — `6 × 2 × 3 × 2 = 72` at the defaults — surfaced at init as `worstCaseReviewerCalls` so the operator sees the multipliers before spending.
- Actual cost is lower: cancellation kills in-flight peers on a final failure, so a failing attempt bills the completed slots plus a partial for the rest.
- Unlatching stays the existing audited path: fix the environment, then `resume --clear-failures --reason "…"`.

Re-billing successful peers is the price the requirement's human ruling already accepted: independence is why the feature exists, and recovery efficiency was the thing chosen to sacrifice. The bound makes that price finite and *honestly* visible rather than open-ended.

### 11. The independence boundary

§7 delivers a property; this section states its edge, because a constraint the plan cannot meet is worth naming precisely rather than discovering later.

**Guaranteed by construction.** No byte derived from a slot's output exists at a pathname a peer can construct, discover, or read from the process table, at any point in the round:

| Surface | Why a peer cannot read it |
| --- | --- |
| Reviews | In memory until the whole round commits (§7a) |
| `failures/*.json` | Content-free vocabulary + hash; no provider text (§7b) |
| `run.log`, thrown errors, terminal | Quarantined and dropped on failure; error text is orchestrator-constructed (§7c) |
| Repo temp files | Swept before any provider spawns (§7d) |
| codex output | Nameless fd, passed by descriptor; argv shows only `/dev/fd/3`, which resolves in the reader's own fd table (§7e) |
| stdout spool | Nameless fd, created before `spawn`, inherited by descriptor (§7e) |
| Windows | Multi-reviewer refused; no peer exists (§7f) |

**Not guaranteed — and out of reach behind the requirement's own non-goal:**

1. **Same-uid kernel introspection.** On Linux, a process can walk `/proc/<pid>/fd/` of another process running as the same uid and open its descriptors, which defeats an unlinked file — and defeats any fd-based scheme, including this one. Nothing implementable in Node closes it; the lever is process isolation — a separate uid, a mount namespace, or a sandbox that denies reads outside the repository — which is precisely the read-isolation the requirement declares a non-goal ("the codex adapter runs a read-only, not read-isolated, sandbox"). The plan does not claim to close it and does not pretend the fd work above is a substitute. macOS, the platform in use, has no `/proc` and is unaffected; Windows is refused outright.
2. **A reviewer that deliberately reads `.plan-forge/`.** Committed prior-round artifacts and the roster in `task.json` are legitimately readable and always will be. Same non-goal. Scoped in the Q3 answer.
3. **A `readdir('/tmp')` inside the microseconds between `mkdtemp` and `rmdir`** in `openNamelessTempFd`, against a directory whose mode denies enumeration, on a file that is still empty and not yet inherited by any child. Closing even this would need the `0300` mode to be load-bearing, which §7(e) declines to claim. Named for completeness, not because it is reachable.

The distinction that matters for the frozen requirement: (1) and (2) require a reviewer to *go hunting* outside the job it was given, using a facility the requirement has already ruled out of scope; the channels §7 closes required a reviewer only to *look* — a fixed glob, a directory listing, or a `ps`. This plan removes every channel of the second kind. If the project later wants the absolute property, the single lever is read-isolating the sandbox, and that is a separate requirement.

### 12. Files changed

| File | Change |
| --- | --- |
| `lib/findings.mjs` | split `normalizeReviewerOutput`; add `validateSlotReview`, `mergeRoundReviews`, `applyRoundToMap`; round-aware `collectFindings`; per-slot relation resolution; `raisedBy`/`dispositions` |
| `lib/workflow.mjs` | `reviewerSlots`; roster + platform + provider-name validation; frozen per-slot model resolution in `initializeTask` (§1.2); roster-aware `updateTaskSettings` (§1.4); concurrent reviewing phase; `commitRoundReviews`; `handleRoundFailure`; round accessors; `merge.json`; manifest/approval/brief/label updates; roster-gated `status` fields; temp sweep; `PROVIDER_ATTEMPTS_PER_INVOKE` |
| `lib/artifacts.mjs` | `roundPaths.reviews` / `.merge`; temp-file sweep helper |
| `lib/logger.mjs` | `quarantine()` / `flush()` / `drop()`; `NOOP_LOGGER` parity |
| `lib/process.mjs` | `openNamelessTempFd`; nameless stdout spool opened `w+` and collected by positional reads from the fd; `extraFds`; win32 named-path fork; `signal` support + `aborted` result; `safeReason` on `ProviderError` |
| `lib/providers/codex.mjs` | `--output-last-message /dev/fd/3` over a nameless fd (S1-A) or final message from the event stream (S1-B); positional read; no temp dir; accept `signal`; `safeReason` on its error paths |
| `lib/providers/claude.mjs` | accept `signal`; `safeReason` on its error paths |
| `cli.mjs` | ordered `tokens`; repeatable `--reviewer` + slot-scoped flags; `providers.reviewers` built from frozen slot models (no `resolveModel` for roster slots); roster warnings; reject `--reviewer` on resume |
| `docs/design.md` | new §4.4 and the §11 boundary; updates to §2, §3, §4.2, §5.3, §6, §7, §9 |
| `SKILL.md`, `skills/plan-forge/SKILL.md` | repeatable `--reviewer`; every multi-reviewer slot needs a pinned model; cost scaling incl. the retry multiplier; all-or-nothing re-bill; no live reviewer stderr at N>1 and the one-slot reproduction hatch; win32 single-reviewer only |
| `prompts/*.md`, `schemas/*.json` | **unchanged** |

## Verification

### Spike (before implementation)

**S1 — codex writes its final message to a nameless descriptor.** One live run: open a nameless fd, pass it as the child's fd 3, and invoke `codex exec --json --output-schema … --output-last-message /dev/fd/3 -`. Confirm the result is written and reads back byte-identical to today's file-based result. In the same run, capture full `--json` stdout and check whether the final structured message also appears as an event. The two observations decide §7(e)'s branch: **A** (`/dev/fd/3` works) → adopt, N=1 untouched; **B** (it does not, but the stream carries the message) → take the stream and accept the two documented error-string deltas; **C** (neither) → stop and escalate per §7(e). This is the plan's only assumption about an external CLI, it is one invocation, and it is settled before any code is written.

### Unit tests — `test/findings.test.mjs`

Existing cases pass **unmodified**, because `normalizeReviewerOutput` keeps its signature and semantics via the one-slot merge. New cases:

1. **ID allocation across slots** — R1 emits two new findings, R2 emits one; assert `F001, F002` → R1 (array order) and `F003` → R2 (slot order). Swap the roster order and assert the IDs follow the roster, not arrival order.
2. **Deterministic under reordering** — the same slot outputs merged twice yield identical IDs and `raisedBy`.
3. **Arbitration table** — a case per pair, asserting the arbitrated status/severity and the winning slot:
   - `resolved` × `still_open` → `still_open` (R2 wins)
   - `withdrawn` × `severity_changed(minor)` → `OPEN(minor)`
   - `still_open`(blocker) × `severity_changed(minor)` → `still_open` at blocker — *the downgrade does not clear the gate*
   - `still_open`(minor) × `severity_changed(blocker)` → blocker — *the upgrade is not discarded; the case that kills a flat `still_open` rule*
   - `resolved` × `withdrawn` → `resolved` (tie → lowest slot)
   - `still_open` × `still_open` → `still_open`, R1's explanation
4. **Streak increments once per round, not per slot** — a 3-slot round with all `still_open` moves `criticalReviewStreak` 0→1, and two such rounds reach the stall gate at exactly 2 (not 3 or 6).
5. **`raisedBy` traceability** — every merged finding maps to exactly one slot (AC5).
6. **Slot-local verdict self-check** — three cases, pinning that the check is an equality against the slot's **own** view and nothing else:
   - a slot filing a blocker and voting `approved` is rejected with today's message;
   - a slot whose own view has **no** blocking finding **must vote `approved`**, and that vote is *accepted* even though its peer files the round's only blocker and the round verdict composes to `changes_requested`;
   - the same slot voting `changes_requested` with nothing blocking in its own view is **rejected**.
7. **Round verdict = AND** — approved×approved → approved; approved×changes_requested → changes_requested.
8. **Union property** — a table-driven check that the merged blocking set is exactly the union of the per-slot blocking sets, compared **through the merge's own ID mapping** rather than by raw id equality. Pre-existing findings compare by id directly; each slot's new findings compare via `(slot, arrayIndex) → allocatedId`, because two slots each filing one blocker both see the provisional `F001` in their own view while the merge allocates `F001` and `F002`, so literal set equality is false by construction and asserting it would fail a correct implementation. Assert the corollary: `roundVerdict === 'approved'` ⟺ merged blocking set is empty ⟺ every slot voted `approved`.
9. **Relation rules (§4.1)** — three cases:
   - **N=1 compatibility**: an output whose second new finding sets `relatedToFindingId` to the id allocated to its *first* new finding — an output today's `lib/findings.mjs:168-188` accepts — is still accepted, and a `recurrence` of that shape still inherits the ancestor's streak. Written against the current implementation's behavior first, so it fails if the narrowing ever returns.
   - **N>1 self-reference**: the same shape within one slot of a two-slot round is accepted against that slot's own allocations.
   - **N>1 cross-slot reference**: R2 naming an id allocated to R1 is rejected with `new finding relates to unknown id F001`.
10. **Legacy wrappers** — wrappers without `meta.slot` collect as `R1`.

### Integration tests — `test/workflow.test.mjs`

Helper changes are additive: `initTask` accepts `reviewers: [...]`; `fakeProvider` accepts `{ delayMs }` and observes `signal`, recording `aborted` (defaults preserve every existing call site).

11. **N=2 happy path** — disjoint findings from both slots merge to `F001..F003`, one revision answers all three, both slots disposition all three, both approve → `approved`. Asserts `reviews.json` holds 2 wrappers with `slot: R1/R2` and equal `promptSha256`.
12. **Conflict drives a revision** — R1 `resolved`, R2 `still_open` → merged `still_open`; the author omitting that resolution is rejected; the round verdict is `changes_requested`.
13. **Downgrade does not clear the gate** — R1 `severity_changed → minor`, R2 `still_open`(blocker) → still blocking; not finalized.
14. **All-or-nothing (AC6)** — 2 slots, R1 returns a valid review, R2 fails. Assert:
    - `rounds/002/` contains **no** `reviews.json`, `review.json`, `merge.json`, or `manifest.json`;
    - exactly **one** `failures/*.json`, with `rejectedOutput: null`, no slot `message`, and `slots[].reason` from the closed vocabulary;
    - on re-run, **both** slots are called again (`r1.calls === 2`) and the round commits with IDs allocated fresh from `before` (no gap).
15. **No peer artifact readable on the re-run (AC7)** — R1's output carries a sentinel string. After the failed round, walk **every** file under `.plan-forge/<task>/` (reviews, `failures/`, `run.log`, `state.json`, temp files) and assert the sentinel appears nowhere. Repeat with R2 failing *normalization* (so `rawOutput` exists) to cover the `failures/` path the requirement named.
16. **Live first-pass observation (§7e)** — R2 is a fake that, *while running*, sweeps for anything R1 has left: it walks `os.tmpdir()` recursively, greps every file it can open, reads its own `/proc/self/cmdline` equivalent and every `ps` argv line it can see for paths under `os.tmpdir()`, and walks the repo. R1 completes first with a sentinel in its output. Assert the sentinel appears nowhere R2 could read, and that **no argv of any live plan-forge child contains a path under `os.tmpdir()`** — the assertion that fails against today's `lib/providers/codex.mjs:36` and pins the argv channel closed.
17. **Redirected stderr (§7c)** — drive an N=2 round failure with the logger's `stderr` sink pointed at a file **inside the repository**, and assert (a) no raw provider text reaches it, (b) the thrown error's `message` contains no provider output, only the round summary and a closed-vocabulary reason, and (c) `run.log` gained no `*:stderr` lines. Then run an N=2 round to success and assert the quarantined lines *do* land in `run.log` at commit.
18. **Crash mid-commit leaves nothing readable** — plant a `.reviews.json.<pid>.<uuid>.tmp` containing a sentinel in the round dir, run resume, assert it is swept before the reviewers are invoked and the sentinel is gone.
19. **Cancellation** — R1 fails fast, R2 has `delayMs`; assert R2's fake observed `abort`, its slot record is `outcome: 'aborted'`, and no separate failure record exists for it.
20. **Q4 bound, including the retry multiplier (§10)** — two sub-cases against one always-failing slot:
    - a **non-retryable** failure: `needs_human` after exactly `maxProviderFailures` round attempts, with `maxProviderFailures × N` total reviewer calls;
    - a **retryable** failure (`ProviderError('overloaded', { retryable: true })`): the same number of round attempts and failure records, but `maxProviderFailures × N × PROVIDER_ATTEMPTS_PER_INVOKE` total calls — asserted against the exported constant, and asserted to be strictly greater than the naive bound so the multiplier cannot silently vanish.
    Both assert the round counter never advanced and that `--clear-failures` + `resume` recovers. Assert the `worstCaseReviewerCalls` value logged at init equals the constant-derived product.
21. **`merge.json` audit** — records the composed verdict, per-slot verdicts and frozen models, `raisedBy`, and for a conflicted finding both `bySlot` positions plus `arbitrated`. Re-deriving after an unrelated human override leaves the file byte-identical (no churn).
22. **`needs_human` brief for N>1** — carries `Raised by`, every slot's position, and marks the arbitrated one.
23. **Approval for N>1** — `approval.reviewSha256` hashes `reviews.json`; `gate.reviewerVerdicts` lists both slots; recovery after deleting `final.md`/projections/`manifest.json`/`merge.json` re-derives with **zero** provider calls.
24. **Corruption guards** — `reviews.json` with the wrong count, wrong slot ids, a provider disagreeing with the roster, **a `meta.model` disagreeing with its slot's frozen model**, or both layouts present each fail with a specific error and never reach a model.
25. **Swapped providers are refused before spawning (§1.3)** — a two-slot roster `[codex, claude]` handed `providers.reviewers = [claudeFake, codexFake]`. Assert the run fails naming the slot, **both fakes report `calls === 0`**, no `reviews.json`/`merge.json`/`manifest.json` exists, no failure record is written, and a corrected re-run commits the round normally.
26. **win32 roster gate (§1.1)** — with `process.platform` stubbed to `'win32'`, `initializeTask` with two reviewers is rejected with the named error, and `runWorkflow` on a two-slot `task.json` is rejected before any provider is invoked; a one-slot task is unaffected on the same stub.
34. **Frozen models and environment drift (§1.2)** — four cases:
    - `initializeTask` with `reviewers: [codex, claude]` and no models and no env vars is **rejected**, naming the slot and the env var; the same roster with `--reviewer-model` per slot persists the resolved strings.
    - a roster created with `PLAN_FORGE_CODEX_MODEL=gpt-5.6` persists `"gpt-5.6"`; resuming with the variable **unset** (and again with it set to a different value) still builds R1 with `gpt-5.6` and commits `meta.model === 'gpt-5.6'` — the assertion that fails against a `buildRuntime` that re-resolves.
    - `--reviewer codex --reviewer codex` with no models is rejected (§1.3's accidental-duplicate case), while two explicit identical slots warn and run.
    - **N=1 is untouched**: `initializeTask` with one codex reviewer and no model still persists `reviewerModel: null`, still resolves from the environment at run time, and its round still commits `meta.model: null`.
35. **Roster-aware `updateTaskSettings` (§1.4)** — four cases:
    - **timeout-only** update on an N=2 task: `reviewerTimeoutMs` changes, `task.json` gains **no** `reviewer`/`reviewerModel`/`reviewerEffort`/`claudeReviewerMaxBudgetUsd` key, and a subsequent `loadContext` **succeeds** — the assertion that fails against today's unconditional writer.
    - **effort** update on an N=2 task: every slot's `effort` is remapped, models and providers are untouched, and the reload succeeds.
    - **invalid effort for one slot**: `--reviewer-effort max` on `[claude, codex]` rejects naming `R2 (codex)`, and `task.json` is **byte-identical to before the call** (no half-applied roster).
    - **N=1 unchanged**: `test/workflow.test.mjs:265-285` passes unmodified.

### Adapter and process tests — `test/providers.test.mjs`, `test/process.test.mjs`

27. **Nameless temp fd semantics** — `openNamelessTempFd` returns an fd that round-trips a positional write/read; **after it returns, `os.tmpdir()` contains no entry matching the prefix** (no directory, no file); `fstat` on the fd reports the written size; closing it is the only cleanup. Skipped on win32.
28. **codex's result is unreachable (S1-A)** — with a stubbed `codex` that writes to `/dev/fd/3` and sleeps, assert its argv contains **no path under `os.tmpdir()`**, that no file under `os.tmpdir()` holds the output, that `**/last-message.json` matches nothing anywhere, and that the returned `data` is byte-identical to today's fixture — the adapter's contract does not move. Under S1-B the same assertions hold with the stream-parsing branch, plus a case pinning each new error string.
29. **stdout spool (F009)** — five sub-cases against a stubbed child, each of which a naive fd implementation fails:
    - **large output**: > 1 MiB of stdout is returned **in full** (the `lib/process.mjs:38-42` truncation guarantee is why the spool exists), proving the positional-read loop handles short reads and that the child's advancing of the shared offset does not blank the result;
    - **nameless**: during the run, nothing under `os.tmpdir()` contains the child's stdout and no entry matches the spool prefix;
    - **overflow**: stdout past `maxBuffer` sets `overflow: true`, returns `''`, and kills the child — today's contract, now via `fstat`;
    - **spawn error**: `child.on('error')` still collects and closes exactly once, with no fd leak (assert against a descriptor count) and no `/tmp` residue;
    - **cancellation / hard kill**: an aborted or SIGKILLed child leaves no spool behind and returns whatever was written before the kill.

### Backward compatibility

30. **N=1 artifact and surface pin (byte-for-byte)** — a single-reviewer task's round dir contains exactly `author-output.json, plan.md, resolution.json, review.json, manifest.json` — no `reviews.json`, no `merge.json`; `task.json` has no `reviewers` key and keeps `reviewerModel` unresolved; `review.json.meta` has no `slot`; `manifest.json` has `reviewSha256` + `reviewerMeta` and no `reviewers`; `approval.gate` has no `reviewerVerdicts`. Deep-equal `inspectTask`'s output against a fixture captured from the current implementation, asserting `blockingFindings[]` has **exactly** today's keys and **no** `raisedBy` or `dispositions`. Deep-equal the prompt built by `buildReviewerPrompt` against a fixture to pin `promptSha256`.
31. **Legacy resume** — hand-build a task dir in today's format (`task.reviewer: 'codex'`, committed `rounds/001/review.json` without `meta.slot`), resume, and assert round 2 writes `review.json` again, findings collect with `raisedBy: 'R1'`, and the run reaches `approved` without touching the author for round 1.
32. **Existing suite unmodified** — `node --test test/` passes with no edits to existing assertions; `providers: { author, reviewer }` still works via the normalization shim. Under S1-B, the sole permitted edit is the two codex malfunction message strings in `test/providers.test.mjs`, and that edit is called out in the PR description.

### Prompt tests — `test/prompts.test.mjs`

33. **Prompts are roster-blind (Q3)** — the reviewer prompt for a 2-slot task is byte-identical to the 1-slot prompt and identical between slots; it contains no slot id, roster size, or peer reference. The author prompt carries no `raisedBy`.

### Acceptance criteria mapping

| AC | Where satisfied | Tests |
| --- | --- | --- |
| 1 — N reviewers concurrently; N=1 as today | §1, §6; one-slot merge path | 11, 30, 31, 32, 34, 35 |
| 2 — race-free, deterministically ordered IDs | §4.1 | 1, 2, 9 |
| 3 — defined and justified arbitration | §4.2, Q1 | 3, 4, 12, 13 |
| 4 — explicit verdict composition | §4.4 | 6, 7, 8, 11, 12 |
| 5 — every finding traceable to reviewer **and model** | §1.2, §5, §9 | 5, 11, 21, 24, 34 |
| 6 — all-or-nothing round | §2, §6, §8 | 14, 18, 19, 20 |
| 7 — no regressions; merge, conflict, boundary, no readable peer artifact | all | 14, 15, 16, 17, 18, 32 |
| Independence enforced (constraint) | §7, §11 | 15, 16, 17, 26, 27, 28, 29 |

### Manual verification

- `node --test test/` — zero model spend, full suite.
- `plan-forge doctor` — unaffected (no new CLI flags on either provider).
- One opt-in live run: `--reviewer codex --reviewer-model gpt-5.6 --reviewer claude --reviewer-model claude-opus-4-8`, on a requirement with a known seeded defect that the requirement's evidence says one model catches and the other misses. Confirm the merged set is the union, `merge.json` shows the disagreement and both frozen models, and `promptSha256` matches across slots.
- One live all-or-nothing check: kill the process mid-round (`SIGKILL`) and confirm `resume` re-runs every slot, that `grep -r` over `.plan-forge/<task>/` finds no fragment of the round's reviewer output, and that `ls /tmp` shows no `plan-forge-*` leftovers at all — with nameless fds there should never be one, even after a hard kill.
- One live independence check: during a two-slot round, from a third shell as the same user, run `ps -ww -o args= -p <each child pid>` and confirm no argv names a path under `/tmp`; then `ls /tmp | grep plan-forge` and confirm it is empty. This is the manual counterpart to test 16 and the check that would have caught the argv channel §7(e) closes.

---

## Appendix: Frozen Requirement

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

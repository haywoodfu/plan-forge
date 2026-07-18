<!-- plan-forge: task=concurrent-reviewers-v2 round=3 author=claude reviewer=codex status=needs_human stoppedAt=2026-07-15T16:54:53.013Z blockingFindingIds=F001 planSha256=cb89725f70c2e584030ef84acebeab4837117b9fbced294ce1088b89887ba6cd requirementSha256=e5848a6cc13b641be65236d68cac94790b4f9bd0a90075d6edc726481bd254bc -->

# Decision required — concurrent-reviewers-v2

This plan **did not pass the gate**. It stopped at round 3 because a blocking finding survived two consecutive re-reviews.
Nothing below is approved. 1 finding(s) block it: F001.

## F001 — blocker · §9.2 Reviewer independence

**Problem**

A resumed reviewer can read a successful peer's same-round review file. That violates the frozen requirement that reviewers operate independently and can anchor the resumed reviewer on its peer's findings, reducing the defect-union coverage this feature exists to provide. Recording the exposure as `isolation: 'resumed'` documents the violation but does not satisfy the constraint.

**Required change**

Provide an enforceable resume design that preserves successful peer output without exposing its findings to pending reviewers, while still rerunning only failed slots. Merely omitting findings from the prompt or recording the exposure is insufficient; if the constraints cannot be satisfied together, the plan must identify that as a requirement-level blocker rather than claim acceptance.

**Evidence**

- docs/requirements/concurrent-reviewers.md:5-7 requires concurrent and independent reviews within a round.
- docs/requirements/concurrent-reviewers.md:50-51 states that concurrent reviewers must not see each other's findings.
- Acceptance criterion 6 at docs/requirements/concurrent-reviewers.md:62-63 requires preserving A while rerunning only B.
- The plan's §9.2 and proposed test 16 deliberately assert that resumed r2 can read `reviews/r1.json`.
- The current providers receive repository-wide read access: lib/providers/codex.mjs:27-30 runs Codex at `repoRoot` with a read-only rather than read-isolated sandbox, while lib/providers/claude.mjs:15-22 exposes unrestricted Read/Glob/Grep paths.

**Reviewer's position** (last reviewed round 3, status `still_open`)

The plan now correctly identifies the requirement-level conflict, but its claimed independence invariant still has a concrete leak. `invokeWithLimit` attaches a reviewer’s structured output as `error.rawOutput` when normalization fails (`lib/workflow.mjs:169-171`), and the existing failure handler persists it as `rejectedOutput` under the task’s readable `failures/` directory (`lib/workflow.mjs:307-319`; `lib/artifacts.mjs:223-225`). Section 11.2 retains this failure-record behavior, while proposed test 21 explicitly requires raw output on the two-slot normalization-failure path. On resume, every rerun reviewer can therefore read a failed peer’s complete same-round findings. Atomic `reviews.json` and redacted `discarded.json` do not prevent this. Multi-reviewer failure records must omit or redact reviewer judgments before any resumed slot runs, and isolation test 14 must inspect `failures/` as well as review/discard artifacts.

**Author's position**

`accepted` — Accepted, and strengthened on the two axes the finding attacks. (1) The proof gap is closed. The previous argument jumped from 'durability means the filesystem' to 'only an OS read jail could help', which left unenumerated mechanisms that are not read jails. §1.1 now enumerates every durable-hiding mechanism reachable without touching the adapters and answers each on its own terms: relocation (`--cd` at lib/providers/codex.mjs:28 sets a working directory, not a read jail), obscurity (Glob/Grep are granted at lib/providers/claude.mjs:21), encryption (a key durable to the resume is a same-user-readable file), an OS keychain (reachable from a codex slot, whose `--sandbox read-only` at lib/providers/codex.mjs:29 bounds writes but permits command execution, and unreachable from a claude slot — so not a guarantee), and file mode `0000`, which is the strongest candidate and now gets a real answer rather than a dismissal: POSIX does deny the owner, but `chmod` needs ownership rather than permission bits, so enforcement would rest on whether a third-party CLI's sandbox denies a metadata write on two operating systems — untestable in CI (test/live.test.mjs is opt-in), unowned by this project, and fixable only by constraining the spawn, which is the forbidden non-goal. Only the read jail enforces, and it is that non-goal. §1.1 also states the claim precisely: not 'information-theoretically impossible' but 'no mechanism under (c) yields a property this project can state, own, and test' — an independence guarantee resting on a foreign sandbox's chmod behavior is the same species of claim as 'we asked the model not to look', which this finding already rejected. (2) The finding's escape clause — identify it as a requirement-level blocker rather than claim acceptance — is now unmistakable rather than implicit: new §1.4 states in three lines that the plan does not claim AC6 is satisfied, names the ruling the human must make, and points at §10.3's delta; the Goal opens with it; the acceptance table already carried NOT MET and now carries the enumeration. (3) The cost of the recommended ruling is materially narrowed with new repository evidence rather than argued down: each slot calls `invokeWithLimit` independently and that function already retries once in-process for every `retryable` error — timeouts, overflow, and transient CLI output (lib/workflow.mjs:132-133, 173; lib/process.mjs:163) — so a flaky slot is rescued inside the pass while its peers' output is still only in memory. The discard path is reached only on a non-retryable failure or process death, which shrinks AC6's window to genuinely rare events; test 12 now asserts the retryable case commits normally with `discarded.json` never created.

## Your options

Only a human decides these. Each override is recorded with your reason and is auditable.

1. **The reviewer is wrong** — you accept the author's counter-evidence:
   ```
   plan-forge override --task concurrent-reviewers-v2 --finding <ID> --disposition withdrawn --reason "<why>"
   ```
2. **Real, but not blocking** — downgrade it; it stays open and on the record:
   ```
   plan-forge override --task concurrent-reviewers-v2 --finding <ID> --disposition severity_changed --severity minor --reason "<why>"
   ```
   Then `plan-forge resume --task concurrent-reviewers-v2`.

A ruling settles a **finding**; it is not an approval and does not end the review. Once your rulings leave no
blocker, the author revises with them visible and the reviewer re-reviews — only a reviewer verdict of
`approved` finalizes the plan. Rule on some but not all of the blockers and the task stays stopped, so decide
every one below before you resume.

3. **Neither fits** — if the finding exposes a conflict in the *frozen requirement itself*, no override can
   express the fix. Requirements are immutable by design: amend the requirement and start a **new task id**.
   Deciding the design here and overriding the finding would approve a plan that still contains the defect.

---

# Concurrent reviewers: fan-out, atomic round commit, and merge

## Goal

Let a task run N reviewers (N ≥ 1) against the same plan in one round, concurrently and independently, merge their outputs into one round result, and drive a single author revision from that merged set. Widening defect coverage is the entire point: the frozen requirement documents two competent reviewers whose finding sets barely intersected, so the union of N independent reviews is strictly more informative than any one of them.

After this change:

- `--author claude --reviewers 'codex:gpt-5.6,claude:claude-opus-4-8'` fans out two reviewer subprocesses per round against one `plan.md`, merges their findings, and hands the merged set to one author revision.
- `--reviewer codex` — and every task already on disk — behaves exactly as today, producing byte-identical artifacts and an identical `run.log` event sequence on every path, success and failure alike.
- Reviewer independence is **enforced by construction**, not requested in a prompt: no review of round R exists on disk while any round-R reviewer is running.

Section §1 is load-bearing and must be read first. **This plan is asking for a human ruling on the requirement itself**: two frozen clauses cannot both hold while provider adapters stay unchanged, §1.1 proves it, §1.2 recommends a branch and argues for it, §1.4 states the handoff, and everything after §1 is written against the recommended branch. The acceptance table records AC6 as **not met in letter** rather than claiming acceptance.

## Implementation

### 1. The requirement conflict this plan cannot resolve alone

An earlier revision claimed acceptance of the independence constraint while recording its violation in a `meta.isolation` field. That was wrong, and the reviewer was right to reject it. Working the problem properly shows the requirement is internally inconsistent.

#### 1.1 The inconsistent triple

> **Claim.** These three cannot hold simultaneously:
>
> - **(a)** *Enforced independence.* "Concurrent reviewers must not see each other's findings" (Constraints), as a property of the system rather than a request to the model.
> - **(b)** *AC6's letter.* "If reviewer A succeeded and B failed, resume re-runs only B."
> - **(c)** *The non-goal* "Changing provider adapters."

*Proof.* (b) requires A's findings to survive B's failure **and process death** — resume is a fresh process. Durability across process death means the filesystem: A's findings must be in a file while B runs. Reviewer subprocesses run as the same OS user with unrestricted filesystem reads — `lib/providers/codex.mjs:28-29` passes `--cd repoRoot` (a working directory, not a read jail) and `--sandbox read-only` (which bounds writes and network), and `lib/providers/claude.mjs:21` passes `--tools Read,Glob,Grep` (which bounds the *tool set*, not the *path set*).

So the question reduces to: can any mechanism available **without changing the adapters** make a durable file's contents unreadable to a same-user process? The candidates are enumerable, and each is answered on its own terms rather than waved away:

1. **Relocation** — write A's review outside the repository. `--cd` sets a working directory; it does not jail reads. An absolute path still resolves.
2. **Obscurity** — an unguessable name, a buried directory. Not a guarantee against an agent holding `Glob` and `Grep`; it is a bet on the model not looking.
3. **Encryption** — any key durable enough to survive to the resume is itself a same-user-readable file, and a same-user process reads anything its user can read. The key is the plaintext with extra steps.
4. **An OS keychain for the key** — moves the gate to a service that authenticates the *user*, not the process. A codex slot runs commands under `--sandbox read-only` (reads are permitted), so `security find-generic-password` is reachable; a claude slot restricted to `Read,Glob,Grep` cannot. A property that holds for one adapter and not the other is not a guarantee.
5. **File mode `0000`** — the strongest candidate, and the one that deserves a real answer rather than a dismissal. POSIX consults **only** the owner class for the owner, so a same-user process opening a `0000` file genuinely gets `EACCES`; the orchestrator would seal A's file during the pass and unseal it at round commit. It still fails as a *guarantee*, for three independent reasons. `chmod` requires ownership, not permission bits, so any slot that can execute `chmod` re-opens the file at will; `--tools Read,Glob,Grep` denies that to claude, but codex's `--sandbox read-only` bounds writes while permitting command execution, and whether a *metadata* write is denied is an internal property of a third-party CLI's sandbox on two operating systems — something this project neither specifies nor owns, and cannot test in CI (`test/live.test.mjs` is opt-in). Making it enforceable means constraining the spawn ourselves, which is (c). And it is not crash-safe: a death between seal and unseal leaves an artifact `loadRoundArtifacts` can neither read nor distinguish from corruption.
6. **An OS-level read jail around the spawn** (`sandbox-exec`, bubblewrap, landlock) — the only mechanism that actually enforces. It is by definition a change to how the adapters launch their CLIs: forbidden by (c), unportable across two CLIs × two operating systems, and nested inside the sandboxes those CLIs already install.

Every branch either fails to enforce or is (c). ∎

**The precise claim, since it is easy to overstate.** This is not "hiding A's findings is information-theoretically impossible." It is: *no mechanism available under (c) yields a property this project can state, own, and test.* An independence constraint that holds only while a third-party CLI's sandbox happens to deny `chmod` is the same species of claim as "we asked the model not to look" — the claim F001 already rejected, wearing a mode bit.

So exactly one of (a), (b), (c) must give. This is a **requirement-level decision, not an implementation choice**, and this plan does not have the authority to make it silently.

#### 1.2 The ruling this plan recommends, and assumes

> **Recommendation: give up (b), AC6's letter. Keep enforced independence.**

The argument:

1. **Independence is the mechanism of the goal; AC6 is an efficiency criterion.** The requirement's Goal sentence is "review the same plan **concurrently and independently** … The purpose is to widen defect coverage." Independence is *how* coverage widens. If a resumed reviewer anchors on its peer, the merged result is no longer the union of independent draws, and the evidentiary premise of the entire change — two runs whose intersection was near zero — no longer describes what the system produces. Losing that loses the feature. Losing AC6's letter costs money in a rare failure path.
2. **The cost is bounded and small — and the window is narrower than "any reviewer failure".** Each slot calls `invokeWithLimit` independently, and that function already retries once, in-process, for every `retryable` error: timeouts, output overflow, and transient CLI output (`lib/workflow.mjs:132-133, 173`; `lib/process.mjs:163`). A flaky slot is therefore rescued **inside the pass**, while its peers' output is still only in memory and on nobody's disk — AC6's scenario never arises for the failures that actually recur. The discarded-pass path is reached only when a slot fails non-retryably (an auth failure, `incomplete_output`, a normalization error) or the process dies. Then the waste is capped by `maxProviderFailures` (default 2): a persistently broken slot latches `needs_human` after its second failure, so a round can re-pay its healthy slots at most once before stopping. Worst case is roughly 2× that round's reviewer spend, not an unbounded loop.
3. **AC6's purpose survives; only its letter does not.** The criterion is titled "Partial failure resumes." Under the recommendation resume *does* work: it completes the round, loses no committed decision, and re-runs the failed slot. What it also does is re-invoke the healthy slots.
4. **The recommended branch is strictly simpler.** §6's pass invariant falls out of it, and with it go the override prefix-replay machinery, the `meta.isolation` field, the partial-round visibility rules, and the path-dependent finding ids an earlier revision had to confess. Fewer mechanisms, and the constraint is met rather than described.

#### 1.3 The consequence: a round's reviews are one atomic commit

The filesystem cannot rename N files atomically, and `docs/design.md:355-356` forbids using a marker file as the commit point ("Each atomic rename is an independent commit; `manifest.json` is only a per-round audit summary, never the sole commit marker needed for recovery"). So per-slot review files cannot be committed as a set, and a crash between two of them would leave exactly the partial round that (a) forbids.

Therefore, at N ≥ 2, **a round's reviews live in one file, `rounds/NNN/reviews.json`, written by one atomic rename.** A round has all its reviews or none. From this single fact:

> **Pass invariant: a reviewer pass for round R begins only when round R has zero committed reviews.**

The invariant is what makes independence enforceable, and it dissolves two of the requirement's four structural conflicts outright (§6).

**The price, stated plainly:** if a pass fails or crashes, the successful slots' output is not committed and is re-run on resume. Their provider metadata is not lost — §11.2 records it — but their findings are re-derived. At N = 1 the invariant is vacuous (a round has one review; all-or-none is the same thing), so nothing about single-reviewer behavior changes.

#### 1.4 The handoff this plan is asking for

To be unambiguous about what is being claimed:

- **This plan does not claim AC6 is satisfied.** It reports AC6's letter as a **requirement-level blocker** — provably unreachable alongside the independence constraint while (c) holds — and the acceptance table says so in those words rather than papering over it.
- **What the human must rule on** is which of (a), (b), (c) gives. §1.2 recommends (b). If the ruling favours AC6's letter over enforced independence, §10.3 specifies the exact delta; if it favours relaxing (c), that is a different feature (adapter-level sandboxing) and needs its own requirement.
- **The plan is decision-ready under either ruling** and implementable as written under the recommended one. It is not approvable as *satisfying both*.

Everything below assumes the recommended branch.

### 2. The reviewer roster

Everything below is driven by one derived value: the **roster**, an ordered list of reviewer slots frozen at task creation.

```js
// lib/workflow.mjs
// slot: { id: 'r1'|'r2'|…, provider: 'claude'|'codex', model: string|null, effort: string }
export function reviewerRoster(task) -> slot[]   // length >= 1; throws on an invalid task.json
```

Rules:

- `task.reviewers` present ⇒ the roster is that array. Validated: length ≥ 2; ids exactly `r1..rN` in order; every provider in `{claude, codex}`; every effort valid for its provider via `resolveEffort` (`lib/workflow.mjs:73-81`); **every `model` a non-empty string** (§2.1); and `task.reviewer` / `task.reviewerModel` / `task.reviewerEffort` **absent**.
- `task.reviewers` absent ⇒ the roster is `[{ id: 'r1', provider: task.reviewer, model: task.reviewerModel ?? null, effort: task.reviewerEffort ?? null }]`. This is the legacy shape, and it is what `initializeTask` keeps writing whenever N = 1.
- Exactly one shape must be present. Both or neither throws.

`multiReviewer = roster.length > 1` is the single switch for every artifact-shape decision below.

**`task.reviewers` is never written for N = 1**, even when the user passes `--reviewers codex`: a one-entry roster normalizes back to the legacy scalar fields. There is therefore exactly one on-disk representation of a single-reviewer task, and no code path where N = 1 produces new bytes.

The roster is immutable after `initializeTask`. `resume --reviewers` is rejected with `reviewer roster is frozen at task creation; start a new task id to change it`. A mutable roster would break resume and the audit chain. Immutability covers every field of the slot spec — count, ids, providers, models, and efforts; §2.1 is what makes that true of models, and §3.2 is what makes it true of the one function that writes `task.json` after creation.

**There is no hard maximum on N.** The requirement's domain is N ≥ 1 with no upper bound, so a parse-time cap would reject a valid five-reviewer request on an implementation guardrail rather than on anything wrong with it. Cost and concurrency are real and are the user's to spend, so the guardrail is advisory: `run` warns above four slots and proceeds.

```text
warning: 6 reviewers run concurrently against one plan; expect roughly 6x reviewer spend per round
```

The parser rejects only what is *ill-formed*: an empty spec, an empty entry, an unknown provider, an invalid effort. Slots are **not** throttled — fan-out is one `Promise.allSettled` over the whole roster, because serializing slots would turn a round's wall-clock from `max` into `sum` while `--reviewer-timeout` remains per-slot wall-clock, and a queue would be new surface the requirement did not ask for. The practical ceiling is the OS subprocess limit and the account's rate limits; both surface as ordinary provider failures under the existing per-slot accounting (§11.2), which is a better failure mode than a number this plan invented. Two-digit slot ids are therefore reachable, and §8's ordering is numeric so that `r10` sorts after `r2`.

**`loadContext`'s task validation changes** (`lib/workflow.mjs:240-249`). It currently rejects any task whose `task.reviewer` is not `claude`/`codex`, which would reject every roster task. It becomes: keep the existing scalar check **verbatim for the legacy shape** (so an invalid legacy `task.json` still fails with today's exact `task.json requirement identity is invalid`), and validate the roster shape through `reviewerRoster(task)`, which throws `task.json reviewer configuration is invalid`. No existing test asserts the roster message; the legacy message is preserved because it is the one on the existing path.

#### 2.1 A roster slot's model is resolved once and frozen

A slot whose model is `null` is neither frozen nor traceable, and both failures are reachable today:

- **Not frozen.** `resolveModel` reads `process.env` on every call (`lib/workflow.mjs:86-91`), and `buildRuntime` calls it afresh on every `run` *and* every `resume` (`cli.mjs:63-88`). A slot recorded as `model: null` therefore re-resolves against whatever `PLAN_FORGE_CODEX_MODEL` holds at that moment. Round 1 and round 2 of one task can run different models with nothing rejecting it.
- **Not traceable.** With no model resolved, `lib/providers/codex.mjs:38` omits `--model` and `:69-73` writes `meta.model: null` — the CLI's built-in default served the review and the artifact cannot say which model that was. The requirement's audit constraint names `model` explicitly.

> **Rule: every slot of an explicit roster (N ≥ 2) must resolve to a non-null model, and `initializeTask` persists the resolved string into the slot.** `resolveModel(provider, specModel)` is evaluated **once**, at task creation; a null result is a parse error, not a default.

```text
--reviewers slot r2 (codex) has no model; a roster slot must name one
(codex:<model>) or set PLAN_FORGE_CODEX_MODEL — a slot left on the CLI's
built-in default is neither frozen nor traceable
```

Why this is uniform across providers rather than a codex-only exception: codex cannot report its built-in default at all, and claude can report it (`lib/providers/claude.mjs:51` falls back to `envelope.model`) but only *after* the run — which can record a model, never freeze one at creation. Neither adapter can name its default at task-creation time, so the rule that "freeze at creation" implies is the same for both. And the Background's own disaster is exactly this footgun: the zero-findings, one-round approval came from a codex slot silently landing on a small built-in default. A roster exists to compare reviewers; a slot whose identity is "whatever the CLI picks today" cannot be compared to anything.

**This is not the non-goal "changing model resolution."** The precedence ladder is untouched — explicit flag, then the provider's env var, then null (`lib/workflow.mjs:45-64` documents it and the comment stands). What changes is *when the existing ladder is evaluated* on a *new* code path (once, at creation, instead of on every process start) and that a null outcome is rejected **for roster slots only**. No adapter changes. The legacy N = 1 path keeps evaluating the ladder in `buildRuntime` exactly as today, null included.

`buildRuntime` consequently does **not** call `resolveModel` for roster slots — `slot.model` is already the resolved identity — and does call it for the legacy slot, unchanged. That asymmetry is the compatibility boundary, and it mirrors the effort asymmetry in §3.2:

| shape | `slot.model` means | loader model check |
|---|---|---|
| legacy (N = 1) | the unresolved `task.reviewerModel`, possibly null | none (today's behavior) |
| roster (N ≥ 2) | the model resolved and frozen at creation, never null | `meta.model === slot.model`, strict |

One honest limit: with `--model X` passed, both adapters record `meta.model: X` regardless of what the provider actually served (claude's `model ?? envelope.model` at `lib/providers/claude.mjs:51` prefers the request). The loader check therefore verifies *the slot was invoked with its frozen model*, which is what freezing means. Auditing what the provider substituted server-side is the adapter's business and is out of scope here.

### 3. CLI surface

```text
--reviewer claude|codex                    # unchanged; N=1
--reviewers <spec>[,<spec>…]               # N>=1, no upper bound; mutually exclusive with --reviewer
  spec := provider[:model][@effort]        # e.g. codex:gpt-5.6@xhigh,claude:claude-opus-4-8@max
--reviewer-model / --reviewer-effort       # unchanged; valid only with --reviewer
--reviewer-timeout                         # unchanged; per-role, applies to every slot
--claude-reviewer-max-budget-usd           # unchanged; applies to each claude slot
```

One flag carrying a per-entry spec, rather than three parallel comma-lists, because parallel lists silently misalign when one is short, and a misalignment produces a plausible-looking wrong run instead of an error.

```js
// cli.mjs
export function parseReviewerSpec(text) -> [{ provider, model, effort }]
```

Parsing: split on `,` and trim; per entry split off effort at the **last** `@`, then split off model at the **first** `:`; validate the provider against `{claude, codex}` and the effort through `resolveEffort(provider, effort)`. Empty entries, unknown providers, unknown efforts, and an empty roster throw; there is no upper bound (§2). Model ids contain neither `,`, `:`, nor `@` in practice; the split rule is documented beside the parser. The parser does **not** apply §2.1's non-null model rule — `initializeTask` does, after `resolveModel` has had its chance to supply the model from the environment.

`taskOptions` (`cli.mjs:90-116`) gains `reviewers` and keeps `reviewer`; a one-entry `--reviewers` normalizes to the scalar fields per §2.

#### 3.1 The provider-collision rule

Today: `if (author === reviewer && !values['allow-same-provider']) throw` (`cli.mjs:96-98`).

The naive generalization — "providers across `{author} ∪ roster` must be pairwise distinct" — is **wrong**, and wrong in a way that makes the feature unusable. Only two providers exist, so *every* roster of two or more either repeats a provider or collides with the author. That rule forces `--allow-same-provider` onto every multi-reviewer run, turning a meaningful guard into a flag users paste in reflexively and stop reading.

Go back to what the guard is *for*: a plan must face at least one reviewer that does not share the author's blind spots. That purpose is about the **roster as a whole**, not about each slot:

> **Rule: at least one reviewer's provider must differ from the author's, unless `--allow-same-provider` is set.**

This is a strict generalization that **collapses to today's check at N = 1**: with one reviewer, "at least one reviewer differs from the author" is exactly `author !== reviewer`, so the existing behavior and error message are untouched. And it makes the intended heterogeneous rosters work as written:

| author | roster | verdict |
|---|---|---|
| claude | `codex` | ok (today's pass) |
| claude | `claude` | rejected without the flag (today's throw) |
| claude | `codex:gpt-5.6,claude:claude-opus-4-8` | **ok** — codex is an independent adversary |
| claude | `claude:claude-opus-4-8,claude:claude-sonnet-5` | rejected without the flag — no independent adversary exists |

**Reviewer-vs-reviewer duplication is not an error.** Two codex slots are not a correctness problem; they are a *diversity* problem, and the right response is a warning. After `initializeTask`, `run` warns (never fails) when two slots carry the same frozen `(provider, model)` pair, alongside the size warning of §2:

```text
warning: reviewers r1 and r2 both run codex/gpt-5.6; they differ only by sampling
```

This is a plain comparison of frozen roster fields — no `resolveModel` call, because §2.1 already resolved them. Note what §2.1 removed from this warning's job: a roster slot can no longer land on a CLI built-in default at all, so the specific configuration that produced the Background's zero-findings approval is now unreachable on the roster path rather than merely warned about.

Every example in this plan, in `README.md`, and in `SKILL.md` is checked against this rule and runs as written without `--allow-same-provider`.

#### 3.2 Resume-time settings updates (`updateTaskSettings`)

`updateTaskSettings` (`lib/workflow.mjs:638-657`) is the only writer of `task.json` after creation, and it is **shape-blind**: it spreads `...task` and then unconditionally reconstructs both effort scalars. Against a roster task — where §2 requires the reviewer scalars to be *absent* — that is two defects, both reachable from a supported command:

- `resume --reviewer-timeout 1800`, a change with nothing to do with efforts, still evaluates `reviewerEffort: task.reviewerEffort ?? null` and writes **`reviewerEffort: null`**, injecting a forbidden scalar. `reviewerRoster` then rejects the task on its next load: a supported operation bricks the task.
- `resume --reviewer-effort xhigh` evaluates `resolveEffort(task.reviewer, 'xhigh')` with `task.reviewer === undefined`, throwing `unsupported provider undefined` — an internal-sounding error for what is really a flag that does not apply.

The fix, preserving N = 1 byte-for-byte:

```js
export async function updateTaskSettings({
  repoRoot, taskId,
  authorTimeoutMs = null, reviewerTimeoutMs = null, authorEffort = null, reviewerEffort = null
}) {
  const paths = taskPaths(repoRoot, taskId);
  const task = await readJson(paths.task);
  const multiReviewer = reviewerRoster(task).length > 1;   // validates the shape before anything is written
  if (multiReviewer && reviewerEffort) {
    throw new Error(
      "--reviewer-effort applies only to single-reviewer tasks; a roster slot's effort is frozen at task "
      + 'creation (pass provider[:model]@effort to --reviewers, or start a new task id)'
    );
  }
  const updated = {
    ...task,
    authorTimeoutMs: authorTimeoutMs ?? task.authorTimeoutMs,
    reviewerTimeoutMs: reviewerTimeoutMs ?? task.reviewerTimeoutMs,
    authorEffort: authorEffort ? resolveEffort(task.author, authorEffort) : task.authorEffort ?? null,
    ...(multiReviewer
      ? {}
      : { reviewerEffort: reviewerEffort ? resolveEffort(task.reviewer, reviewerEffort) : task.reviewerEffort ?? null })
  };
  await atomicWriteJson(paths.task, updated);
  return updated;
}
```

Byte-identical at N = 1: assigning a key that `...task` already produced does not move it in JS key order, and the conditional spread emits the same `reviewerEffort` key with the same value in the same position. Error ordering is preserved — for a valid single-reviewer task `reviewerRoster` succeeds and `resolveEffort(task.reviewer, 'max')` still throws `invalid effort "max" for codex`, which `test/workflow.test.mjs:281-284` pins.

The CLI needs no change. `cli.mjs:193` already gates on "any of the four flags is set", so the rejection surfaces as a failed `resume` before anything is written — never silently ignored, never a half-updated task. `cli.mjs:195-200` logs `updated.reviewerEffort`, which is `undefined` on a roster task; `fieldText` filters `undefined` out (`lib/logger.mjs:4-9`), so the line simply omits the key.

**Why reject per-slot effort updates rather than support them**, and why the N = 1 asymmetry is principled rather than an accident of compatibility:

1. **Effort is part of the slot spec** (`provider[:model]@effort`). Changing a slot's effort *is* changing the roster, which §2 freezes — exactly as changing its model would be (§2.1).
2. **One unaddressed effort value cannot apply to a heterogeneous roster.** Effort enums are per-provider (`lib/workflow.mjs:40-43`), so `--reviewer-effort max` across `codex:gpt-5.6,claude:claude-opus-4-8` throws on the codex slot. The "apply to all" reading breaks on exactly the rosters this feature exists to enable, and "apply where valid" is incoherent.
3. **Per-slot addressing (`--reviewer-effort r2=xhigh`) is well-defined but is new CLI surface the requirement did not ask for**, with its own parser and precedence rules. Deferred, not foreclosed; the error message names both workarounds.
4. **N = 1 keeps the mutable effort it has today** because backward compatibility demands it (`test/workflow.test.mjs:265-285`) and because there is no addressing ambiguity with one slot. The honest statement: **effort and model are frozen for the explicit roster shape and mutable for the legacy scalar shape** — and the escape hatch that actually matters for a slow slot, `--reviewer-timeout`, applies to every slot on both shapes.

### 4. File layout

```text
rounds/001/
├── author-output.json
├── plan.md
├── resolution.json
├── review.json          # N = 1 only — exactly today's path and bytes (one wrapper object)
├── reviews.json         # N >= 2 only — one atomic commit, array of wrappers in roster order
├── discarded.json       # N >= 2 only, and only after a failed pass (§11.2)
└── manifest.json
```

```js
// lib/artifacts.mjs
// roundPaths keeps its current signature and its `review` key (lib/artifacts.mjs:115-128)
// and gains `reviews` and `discarded` alongside it.
export function reviewsPathFor(taskDir, round, roster)   // roster.length === 1 ? files.review : files.reviews
```

`reviews.json` is `{ schemaVersion: 1, reviews: [wrapper, …] }`, one entry per roster slot in roster order, each entry the same `{ meta, review }` wrapper shape that `review.json` holds today. One `atomicWriteJson` is one rename is one commit — which is what §1.3 requires and what `docs/design.md:346-347, 355-356` already demands of every artifact.

**Provenance is `meta.reviewerId`,** carried by each wrapper. It was always in the metadata; with a single file it is now the only carrier, which is simpler than a path convention and is what the manifest (§12) records durably. Acceptance criterion 5 is met by `meta` plus the manifest.

### 5. Wrapper metadata

`wrapperMeta(…, extra)` (`lib/workflow.mjs:107-127`) gains two keys, for multi-reviewer tasks only:

```js
extra: {
  planSha256: sha256(author.plan),
  reviewerId:    multiReviewer ? slot.id : undefined,
  overrideCount: multiReviewer ? overrideCount : undefined   // ternary, never `count || undefined`: 0 is a real value
}
```

`JSON.stringify` drops `undefined`, so for N = 1 the emitted key set and key order of `review.json`'s `meta` are unchanged, and therefore so is `fileSha256(review.json)` — which `approval.json` binds. This "`undefined` ⇒ key absent" idiom is used deliberately and consistently throughout (§10.2, §12), and `meta.reviewerId` present ⇔ multi-reviewer task becomes an invariant the loader relies on.

`overrideCount` is `context.overrides.entries.length` as captured at the start of the pass that produced the review. It exists for one reason: `merge` in the manifest must be reconstructable at backfill time (§8.3), and overrides can be appended *after* a round completes, so the manifest cannot recover the round's override set from the live log alone. There is no `isolation` field: under §1.2's ruling every review is produced with no peer artifact on disk, so the field would be a constant.

### 6. What a reviewer is shown, and why three of the four conflicts dissolve

The requirement names four structural conflicts. The pass invariant (§1.3) removes two of them without any new mechanism, and shrinks a third.

At the moment a pass for round R runs, round R has zero committed reviews. Therefore `context.reviews` contains exactly the reviews of rounds < R, and `context.findings = collectFindings(context.reviews, context.overrides)` (`lib/workflow.mjs:254`) is exactly the **round-entry view**. Every slot of the pass is handed that one view, captured once, in one prompt object.

- **Conflict 3 (disposition coverage) dissolves.** Each slot must disposition `activeFindings(context.findings)` — the same set for every slot, because there is only one set. A peer's same-round finding cannot be in the required set because it does not exist yet, so no slot can report `missing` and none can produce an `extra`. The existing check (`lib/findings.mjs:138-146`) is kept **verbatim**; it was never the problem.
- **Conflict 2 (verdict self-check) dissolves.** `after = collectFindings([...context.reviews, thisReview], overrides)` is the slot's **local view** — precisely what `prompts/reviewer.md:54` asks it to reason about ("Use `approved` only when no unresolved `blocker` or `major` remains after applying your dispositions and new findings"). The self-check at `lib/findings.mjs:196-200` stays and stays meaningful; it never asks a reviewer to predict its peer, because it never sees one.
- **Conflict 1 (id allocation) shrinks** to "all slots share one provisional cursor, so stamp at commit in roster order" (§7).
- **Conflict 4 (`loadRoundArtifacts`)** is a real change (§9), but a smaller one than expected: `reviews.some((item) => item.meta.round === R)` at `lib/workflow.mjs:472` and `:526` stays **correct as written**, because a round has reviews if and only if it is complete.

The call at `lib/workflow.mjs:556-562` therefore keeps its exact arguments for every slot at every N:

```js
normalizeReviewerOutput(data, { round: currentRound, priorReviews: context.reviews, overrides: context.overrides })
```

No round-entry filter, no override prefix replay, no snapshot artifact. An earlier revision needed all three to defend against a round whose slots ran in different passes under different override sets; §1.3 makes that state unreachable, so the defect those mechanisms guarded cannot occur rather than being guarded against. What survives from them is the *recorded fact* — `meta.overrideCount` (§5) — because the manifest still needs it, plus the loader checks in §9 that keep it honest.

One consequence worth naming, because it is an improvement rather than a compromise: a human override appended while a round sits failed **is** seen by that round's re-run reviewers, since the pass reads the live set. The human's ruling reaches every role immediately.

### 7. Finding ID allocation (conflict 1)

Every slot of a pass validates against the same `before` map, so every slot's provisional ids collide with its peers'. Validation, however, does not depend on ids at all — so the two concerns separate cleanly.

#### 7.1 Splitting validation from id stamping

Every check in today's `normalizeReviewerOutput` — disposition coverage, explanation presence, the `effectiveSeverity` coercions, `relatedToFindingId` resolution, the novelty/problem/requiredChange checks, and the verdict self-check — is a function of the round-entry view and the reviewer's own output. The verdict self-check keys off `blockingFindings(after)`, whose membership depends on severity, never on an id. **Only the `F00n` stamping needs a cursor.**

```js
// lib/findings.mjs
export function validateReviewerOutput(output, { round, priorReviews, overrides })
  -> { normalized, findings, requiredBefore, coercions, provisionalCursor }
// Every check of today's normalizeReviewerOutput, in today's order, throwing today's messages.
// Stamps *provisional* ids from provisionalCursor = nextFindingNumber(before), exactly as today.

export function renumberFindings(normalized, cursor) -> normalized'
// Pure and total; never throws. Remaps this review's provisional id block onto
// [cursor, cursor + newFindings.length) order-preservingly, rewriting both `id` and any
// `relatedToFindingId` that points inside the same review's provisional block.
// Identity when cursor === provisionalCursor.

export const normalizeReviewerOutput = validateReviewerOutput;   // unchanged for every existing caller
```

The `relatedToFindingId` remap is not hypothetical: today's loop adds each newly assigned id to `knownIds` *before* validating the next finding (`lib/findings.mjs:185-188`), so a new finding may legally reference an earlier new finding in the same review. Renumbering must carry that reference with it, and being a bijection on a contiguous block, it does.

`validateReviewerOutput` returns one extra key; `test/findings.test.mjs` reads `result.normalized` and `result.coercions` and never deep-equals the return object, so this is invisible to it.

#### 7.2 Allocation is race-free, ordered, and path-independent

**Rule: the cursor is seeded from the committed reviews, and the pass's outputs are stamped in roster order immediately before the single atomic write.**

```js
export function nextFindingNumberFromReviews(wrappers) {
  // max over every wrappers[].review.newFindings[].id matching /^F(\d+)$/, plus 1
}
```

A direct scan of committed review artifacts rather than of a merged findings map: it makes "an id is never reused" a property of the artifacts alone, independent of merge semantics, arbitration, and overrides, so no future change to the fold can reintroduce a collision.

The race is eliminated structurally, not by locking. Provider calls are concurrent (subprocess I/O), but the orchestrator is single-threaded and stamps after all calls settle, folding the roster in order and advancing the cursor by each slot's new-finding count. Nothing is written until every slot has been stamped, so no cursor is ever read twice.

**Ids are fully path-independent under §1.2's ruling**, which is a strict improvement the alternative branch cannot offer. Because a round's reviews are committed only as a complete set from a single pass, no failed pass ever leaves stamped ids behind, and no discarded output ever reserves a number. Given the committed history and the roster, the ids of round R are determined — regardless of how many passes failed first, and regardless of which slot's subprocess happened to return first. Acceptance criterion 2 asks for race-free and deterministically ordered allocation; this delivers both with no caveat.

**For N = 1 the renumber is provably the identity**, which is what keeps `review.json` byte-identical. The commit cursor is `nextFindingNumberFromReviews(context.reviews)`; the provisional cursor is `nextFindingNumber(collectFindings(context.reviews, context.overrides))`. `applyReviewToMap` only ever adds `newFindings` ids as keys (`lib/findings.mjs:45`) and `applyOverrides` never adds or removes any (`:59-75`), so the map's key set is exactly the set of ids ever stamped and the two cursors are equal. This equality is **asserted at commit** for one-slot rosters rather than assumed.

### 8. Merge semantics (conflict 4, and a latent bug)

`collectFindings(reviewWrappers, overrides)` keeps its signature and input shape (`{ meta: { round, reviewerId? }, review }`), so `test/findings.test.mjs` continues to construct wrappers exactly as it does today. Internally it changes from "fold reviews one at a time" (`lib/findings.mjs:79-80`) to **"fold rounds one at a time"**:

```js
export function collectFindings(reviewWrappers, overrides = { entries: [] }) {
  const map = new Map();
  const byRound = groupByRound(reviewWrappers);   // rounds ascending; within a round, by roster index
  for (const [round, wrappers] of byRound) applyRoundToMap(map, wrappers, round);
  applyOverrides(map, overrides);                 // unchanged, and still last
  return map;
}
```

Roster index is `Number((meta.reviewerId ?? 'r1').slice(1))` — **numeric, not `localeCompare`**, which is load-bearing now that §2 imposes no cap: lexicographic ordering would sort `r10` before `r2` and silently reorder a ten-slot round's fold. `applyOverrides` keeps its position as the final step and its current semantics (`lib/findings.mjs:59-75`): a human override closes or re-severities a finding regardless of what arbitration concluded. Human beats machine, unchanged.

This also fixes a bug a naive fan-out would ship. `applyReviewToMap` increments `criticalReviewStreak` per *review* (`lib/findings.mjs:30-34`). Two reviewers both saying `still_open` in one round would push the streak to 2 and trip `hasStalledCriticalFinding` (`lib/findings.mjs:109-113`) after a single re-review, silently turning the anti-livelock guard into a hair trigger. **The streak counts rounds and must advance exactly once per round**, which the round-level fold guarantees.

#### 8.1 Disposition arbitration (Q1)

```js
const SEVERITY_RANK = { nit: 0, minor: 1, major: 2, blocker: 3 };

function arbitrate(finding, dispositions) {   // dispositions: roster order
  const severityOf = (d) => d.status === 'severity_changed' ? d.effectiveSeverity : finding.effectiveSeverity;
  const open = dispositions.filter((d) => d.status === 'still_open' || d.status === 'severity_changed');
  if (!open.length) {
    const unanimousWithdrawn = dispositions.every((d) => d.status === 'withdrawn');
    const status = unanimousWithdrawn ? 'withdrawn' : 'resolved';
    return { closed: true, status, winner: dispositions.find((d) => d.status === status) ?? dispositions[0] };
  }
  const winner = open.reduce((best, d) =>
    SEVERITY_RANK[severityOf(d)] > SEVERITY_RANK[severityOf(best)] ? d : best);   // ties -> earliest slot
  return { closed: false, status: winner.status, effectiveSeverity: severityOf(winner), winner };
}
```

`severityOf` falls back to `finding.effectiveSeverity` because a `still_open` disposition carries no severity of its own — the schema sets `effectiveSeverity: null` for every status but `severity_changed`, and the coercion path at `lib/findings.mjs:155-165` normalizes echoes back to `null`. The baseline comes from the map, which is built by folding the finding's whole history. This is exactly why §8.3's round verdict is reconstructed from all review history through the round and not from the round's own file: a round's dispositions alone cannot tell you what severity they are dispositioning.

Outcome fields mirror today's exactly: `lastReviewedRound = round`, `lastStatus = outcome.status`, `lastExplanation = outcome.winner.explanation`, `effectiveSeverity = outcome.effectiveSeverity` when the winner is a `severity_changed`, and the streak advances or resets as today. Closed findings keep their streak untouched, preserving the recurrence inheritance the comment at `lib/findings.mjs:19-22` protects. For a round with one disposition the winner is that disposition and every field matches today's assignment line for line.

> **The rule: any reviewer keeping a finding open keeps it open, at the highest severity any open reviewer assigns.** Ties break by roster order — deterministic, otherwise arbitrary.

Why conservative, and why not something cleverer:

1. **Consistency with the union of new findings.** Any single reviewer can *open* a finding — that is the entire purpose of fan-out. A rule where one reviewer's `resolved` closes a peer's `still_open` produces the absurdity that r2 cannot suppress r1's brand-new blocker in round 1 (union) but can erase it in round 2 (arbitration). Openness must be monotone in the same direction in both places, or the system contradicts itself across a round boundary.
2. **Evidence asymmetry.** "The defect is still present at `file:line`" is a positive, falsifiable, evidence-bearing claim. "I no longer see it" is an absence claim. The requirement's own Background documents a reviewer producing exactly that absence claim — zero findings, approved — on a plan carrying two majors. Absence claims from an agent that may simply not have looked cannot outvote presence claims.
3. **Majority voting is actively wrong here.** With N = 2 it is undefined. More importantly, the observed near-zero intersection characterizes these reviewers as *low-recall, high-precision* detectors. Majority voting over low-recall detectors destroys recall — it would systematically discard exactly the non-overlapping findings this change exists to capture. The same argument kills "any `resolved` closes it": it converts N reviewers into a min-strictness system, strictly worse than the best single reviewer.
4. **"Only the raising reviewer may close its own finding"** was considered and rejected: it discards peer evidence in both directions (a strong peer's `still_open` would be ignored), and it does not even solve the stall — a weak *raising* reviewer stalls its own finding forever.

**On Q1's real worry — "would one weak reviewer stall every round indefinitely?" — no, and the bound already exists.** `hasStalledCriticalFinding` fires at `criticalReviewStreak >= 2` (`lib/findings.mjs:109-113`): raised in R1, `still_open` in R2 (streak 1), `still_open` in R3 (streak 2) ⇒ `needs_human` at round 3, with `maxRounds` as a second ceiling. Conservative arbitration does not stall the loop; it **converts reviewer disagreement into human adjudication within at most two extra rounds, and never into auto-approval** — which is `docs/design.md` §7's existing, deliberate answer to non-convergence. The human then uses the existing audited `override --disposition withdrawn|severity_changed`, whose effect on verdicts and on the audit record is specified in §8.3.

The refinement that makes this cheap rather than merely bounded: **surface the disagreement**. A dissented finding carries every reviewer's status and explanation into `status`, the manifest, and the author prompt (§10.2, §12), so the human adjudicating reads `r1: resolved — the plan now restores before unpinning` beside `r2: still_open — Implementation §3 still calls unpin first` and rules in seconds. That is strictly better adjudication material than any single reviewer can produce, and it is the concrete answer to the stall worry: the escape hatch is not merely bounded, it is well-lit.

Deliberately **not** done: escalating faster when dissent is present (e.g. "1-of-3 keeps it open ⇒ `needs_human` immediately"). That would make the blocking decision depend on reviewer count, which is a change to blocking semantics and an explicit non-goal. Dissent is an audit hint and changes nothing about the gate.

Closure kind (`resolved` vs `withdrawn`) is audit-only — both close the finding (`lib/findings.mjs:18-24`) — but is resolved coherently: `withdrawn` ("this finding never should have stood") is the stronger claim and requires unanimity; any mix yields `resolved`.

#### 8.2 New findings: union, and no deduplication (Q2)

New findings are the plain union, in roster order then within-slot output order, each keeping the id assigned at commit. The `duplicate finding id` throw (`lib/findings.mjs:39`) stays — with a disjoint cursor it can now only fire on genuine artifact corruption, which is what it should have meant all along.

**Duplicates across reviewers are not merged.** The costs of not merging are real, small, and bounded:

- The author writes one extra resolution per duplicate, possibly naming the same changed sections twice.
- Each subsequent round, every reviewer dispositions the duplicate separately — O(N) extra dispositions per duplicate per round.
- The duplicates advance their streaks independently but resolve together, so there is no livelock consequence.
- `status` shows two entries where one defect exists — human noise.

The cost of merging is a false merge: two genuinely distinct defects that happen to share a `planSection` get collapsed and **one is silently dropped** — the exact failure this entire change exists to prevent, arriving through the front door. The loss function is violently asymmetric: a missed merge costs tokens and a little noise; a false merge costs a defect. `docs/design.md` §7 already commits to this position ("v1 deliberately excludes 'semantically equivalent findings' … because neither can be judged mechanically and reliably by the orchestrator"), and the observed near-zero intersection says the expected duplicate count per round is small — so merging would buy a small saving at a catastrophic tail. The requirement's non-goals permit LLM-based dedup only if this argument concluded otherwise; it does not.

Deduplication instead lives where judgment already lives and mistakes are recoverable:

- **The author dedups implicitly.** It sees both findings in `ACTIVE FINDINGS` and answers both with one change and two `accepted` resolutions naming the same sections. Its projection gains `raisedBy` (§10.2) so it can see that F002 and F003 came from different reviewers and are likely one defect.
- **The reviewer already has the cross-round mechanism**: `relatedToFindingId` + `noveltyRationale`.
- **The human sees both**, with per-reviewer explanations, at adjudication time.

#### 8.3 Verdict composition (conflict 2, acceptance criterion 4)

Three verdicts exist and **must not be conflated**. Each is a function of a review set *and* an override set; naming both arguments for each is the whole content of this section.

| Name | Where it lives | Review set | Override set |
|---|---|---|---|
| **Reviewer verdict** | `reviews.json` → `reviews[i].review.verdict` | rounds < R + that slot's own output | the live set at the pass (recorded as `meta.overrideCount`) |
| **Round verdict** | `manifest.json` → `merge.roundVerdict` | **all review history through round R** | `entries.slice(0, merge.overrideCount)` |
| **Gate verdict** | `approval.json` → `gate.verdict` (always `approved`; finalize only runs when the gate is open) | every committed review | **live** `overrides.json`, bound by `approval.overridesSha256` |

```js
function roundVerdictOf(context, round) {
  const through = context.reviews.filter((wrapper) => wrapper.meta.round <= round);
  const k = overrideCountOf(context, round);   // the round's recorded meta.overrideCount
  const merged = collectFindings(through, { ...context.overrides, entries: context.overrides.entries.slice(0, k) });
  return blockingFindings(merged).length ? 'changes_requested' : 'approved';
}
```

No new fold: it is `collectFindings` over a filtered wrapper list and a prefix override set. Two details are forced rather than chosen. The round verdict is reconstructed from **all history through R**, not from round R's file alone, because a round's dispositions cannot be folded in isolation — `applyReviewToMap` throws `review references unknown finding` for a disposition whose finding was introduced earlier (`lib/findings.mjs:13`), and a `still_open` carries no severity to fold (§8.1). And it is computed **under the round's own override set, not an empty one**, because excluding overrides would make the round verdict incomparable to the reviewer verdicts that produced it.

The prefix is meaningful because of a property the override log already has: **`applyOverride` only ever pushes** (`lib/workflow.mjs:679-689`), never edits, reorders, or removes, and it refuses once the task is approved (`:673`). Therefore `entries.slice(0, K)` *is* the exact override set as of the moment the log had K entries. Hand-editing `overrides.json` retroactively invalidates every recorded snapshot; §12 makes that explicit at the push site and in the design doc.

**The gate verdict is the only one that decides anything, and it is unchanged.** `runWorkflow` already recomputes it from `blockingFindings(context.findings)` (`lib/workflow.mjs:465`) and already ignores every stored verdict.

**The composition theorem.** Fix a round R.

> **Claim.** Under the round's override set O_R, merged blocking set over history-through-R = ⋃ᵢ (local blocking set of reviewer i).
>
> *Premise, structural rather than assumed:* every slot in round R was validated against the same review set and the same override set. This is the pass invariant (§1.3) plus a single capture: round R's reviews are written by exactly one pass, that pass reads `context.reviews` and `context.overrides` once, and every slot receives those objects. Two slots of one round cannot disagree about their input because there is only one input.
>
> *New findings:* merged new findings are the union and severity is per-finding, so the critical ones union trivially.
>
> *Round-entry findings:* let F be merged-blocking. Some open disposition achieves the max severity s, s is critical, and that disposition's own reviewer leaves F open at s ⇒ F ∈ local(i). Conversely if F ∈ local(i), reviewer i leaves F open at critical severity s; the merged max is ≥ s and severity rank is monotone in criticality, so F is merged-blocking.
>
> *Overrides:* O_R is applied identically and last in both the merged and each local computation, so it commutes with the union. Findings closed by O_R are absent from `activeFindings` (`lib/findings.mjs:93-95`) and receive no disposition from anyone, contributing nothing to either side. ∎
>
> **Corollary.** `merge.roundVerdict === 'approved'` ⟺ **every** stored reviewer verdict in that round is `approved`. The composition rule is unanimity; it is *derived*, not imposed; and it is a statement about the artifacts on disk.

Worked check on the case that most easily breaks: round 1 raises blockers F001 and F002; a human withdraws F001 (log length 1); round 2's pass captures `K = 1`, so the required set lists F002 only and neither reviewer dispositions F001. Both resolve F002 and store `approved`. `roundVerdictOf(2)` folds rounds 1–2 under `[O001]`: F001 closed by the override, F002 closed by both dispositions ⇒ no blocking ⇒ **`approved`**. Unanimity holds. Under an override-free reconstruction, F001 would stay open at blocker and the round verdict would read `changes_requested` against two `approved` reviewers — the artifact contradicting the rule that describes it.

**Where the round verdict and the gate verdict legitimately differ.** Overrides are append-only, and `lib/workflow.mjs:465` finalizes as soon as no blocking finding remains, with no new reviewer invocation. `test/workflow.test.mjs:297-323` is exactly this flow today: a `changes_requested` review, then a human `withdrawn` override, then approval, with `reviewer.calls === 1` and `review.json` untouched. The gate's live override set can therefore be a strict superset of the bound round's, and in that case **an approved task legitimately contains a `changes_requested` round verdict and `changes_requested` reviewer verdicts.** Therefore:

- **Stored reviewer verdicts are raw audit facts, never rewritten and never re-validated at finalize.** Nothing anywhere asserts they equal `approved`. This costs nothing structurally: `validateApproval` only iterates the keys of `expectedApprovalFields` (`lib/workflow.mjs:362-367`), and `gate` is not among them.
- **`merge` is a pure function of immutable inputs**, which is what `writeManifest`'s early return (`lib/workflow.mjs:332`) demands: its inputs are the review files of rounds ≤ R (immutable once committed) and `entries.slice(0, K_R)` with K_R recorded in those files and the log append-only. Whenever `merge` is computed — at first write or at a later backfill — it yields the same value, so `docs/design.md` §3's "recompute and backfill idempotently" contract holds.
- **The exact relationship**, which is what makes the audit chain legible:

  > If the bound round's `merge.roundVerdict === 'changes_requested'` while `gate.verdict === 'approved'`, then `gate.overrides.length > merge.overrideCount` — at least one override was appended after the round's pass, and every such override is recorded in `gate.overrides` and bound by `approval.overridesSha256` (`lib/workflow.mjs:357`).
  >
  > *Why:* at finalize, no round after the bound one holds a committed review, so "all reviews" = "history through R". If the live override set equalled the round's, the gate and round computations would be `collectFindings` over identical arguments and hence identical. So `approved ≠ changes_requested` forces the override sets to differ, and append-only forces the difference to be growth.
  >
  > **Contrapositive, the one a human should internalize:** reviewer disagreement can only become approval through a recorded human ruling — never silently, and never without the ruling being reachable from `approval.json`.

Worked checks (no post-review override, so live = O_R): r1 downgrades a blocker to `minor`, r2 to `nit` ⇒ open at `minor`, non-blocking, both local verdicts `approved`, round `approved`, gate `approved` ✓. r1 says `severity_changed → major`, r2 says `resolved` ⇒ open at `major`, blocking; r1's local verdict is `changes_requested`, not unanimous, round `changes_requested` ✓. Both raise only `minor`s ⇒ no blocking, both `approved`, round `approved` ✓. Now append a `withdrawn` override on that `major`: r1's stored verdict stays `changes_requested`, `merge.roundVerdict` stays `changes_requested`, `merge.overrideCount` stays frozen, the gate verdict is `approved`, `gate.overrides` names O001, and `gate.overrides.length > merge.overrideCount` ✓.

### 9. Loading (conflict 4)

```js
// loadRoundArtifacts (lib/workflow.mjs:195-235), per round:
//   roster.length === 1  -> read files.review exactly as today (one wrapper), push it
//   roster.length >= 2   -> read files.reviews; for each wrapper:
//     schemas.validateReviewer(wrapper.review), meta.round === round,
//     meta.planSha256 === sha256(plan)                                   // all unchanged
//     meta.reviewerId === slot.id            (entries in roster order, exactly one per slot)
//     meta.provider === slot.provider
//     meta.model === slot.model              // strict; slot.model is never null at N >= 2 (§2.1)
//     Number.isInteger(meta.overrideCount)
//       && meta.overrideCount >= 0
//       && meta.overrideCount <= overrides.entries.length
//   cross-slot: every wrapper of the round records the same meta.overrideCount,
//              else `round ${round} reviews disagree on their override snapshot`
//   cross-slot: promptSha256 uniformity is warned about, never enforced (§12)
```

**The completeness check is the corruption check.** A `reviews.json` that does not carry exactly one wrapper per roster slot, in roster order, is rejected with `round ${round} reviews.json does not match the roster`. There is no "partially reviewed round" state to represent: §1.3 makes the file all-or-nothing, so a partial one is a hand-edit or a truncated write, not a state the workflow can be in. The provider/model cross-checks catch a hand-swapped or misfiled entry — a wrapper claiming r2 but produced by r1's provider is corruption, not a review.

**The `overrideCount` bound is two-sided on purpose.** `Number.isInteger(k) && k <= entries.length` alone accepts `-1`, and `entries.slice(0, -1)` does not mean "empty prefix" — it drops the *last* entry, silently reconstructing `merge.roundVerdict` against an override set that never existed. `k >= 0` is the cheap check that keeps §8.3's reconstruction meaningful, and `docs/design.md:355-361` makes the artifacts authoritative for recovery, so malformed snapshot metadata must be rejected rather than interpreted.

Derived values on the context:

- `context.reviews` — flat array of every committed wrapper, sorted by `(round, roster index)`. Feeds `collectFindings` and seeds the id cursor. Every round it contains is complete.
- `context.findings = collectFindings(context.reviews, context.overrides)` — exactly today's expression (`lib/workflow.mjs:254`).
- `lastReview(context)` (`:261-263`) is **unchanged**: `context.reviews.at(-1)` is the last slot of the last complete round, and its `meta.round` is that round. `finalize`, `expectedApprovalFields`, and `inspectTask` keep consuming it.

**The gate and the loop need no new guard.** `lib/workflow.mjs:465` finalizes when `lastReview` exists and nothing blocks; `:472` and `:526` decide the current round with `reviews.some((item) => item.meta.round === …)`. Because a round has reviews if and only if it is complete, all three expressions remain correct at every N, and `runWorkflow`'s terminal transitions are untouched. An earlier revision needed an explicit "never finalize past a round holding a committed review" invariant precisely because per-slot commits made such a round representable; §1.3 removes the state, so the guard has nothing to guard. The pre-existing N = 1 behavior it also pinned is unchanged and still correct at every N: a round authored but *unreviewed* holds no review, so an override that clears the previous round's blocker finalizes that previous round and the unreviewed author output is discarded — the override says the blocker was never real, so the earlier plan should have been approved then.

### 10. Reviewer independence (Q3) and what is now enforced

#### 10.1 Reviewers are not told they have peers — `buildReviewerPrompt` is unchanged

The strongest argument is not the psychological one, though diffusion of responsibility ("the other one will catch it") is a real risk in text-trained models and Q3 raises it fairly. It is **evidentiary**: the entire justification for this change is an observation about *independent single-reviewer runs*. Every reviewer receiving byte-identically today's prompt is what makes the merged result the union of exactly the draws that were measured. Any prompt change makes reviewers condition on their peers' existence, introducing correlation or shirking — both reduce union recall, both are unmeasurable from the evidence we have, and both would invalidate the premise of the change in the act of implementing it. Fan-out is a property of the orchestrator, invisible to the reviewer.

The only thing telling them could buy is less duplicated effort. Per Q2 duplication is cheap and the observed intersection is ~0, so there is nothing to save. And it would cost the audit property that all slots in a pass share one `promptSha256`.

The obvious objection — *identical prompt, identical model ⇒ identical review, so why bother?* — is answered by the intended use: heterogeneous providers. Rostering the same `(provider, model)` twice yields sampling diversity only, which is exactly why §3.1 warns about it.

**The guarantee, stated without hedging:**

> No review of round R exists on disk at any point while any round-R reviewer is running — at any N, on any pass, first or resumed. Peer findings therefore never enter any reviewer's prompt and no peer artifact is reachable by any means, because the artifact does not exist.

This is not a promise made in a prompt, not a request the model could ignore, and not a bet on a third-party sandbox denying `chmod` (§1.1's rejected candidates); it is the pass invariant (§1.3), and it is testable by a probe provider (test 14). It is what F001 correctly refused to accept a substitute for. It costs AC6's letter, which is the trade §1.2 recommends and §1.1 proves is unavoidable.

A residual worth naming honestly: a reviewer at round 2 can read `rounds/001/reviews.json`, and always could — the orchestrator deliberately feeds it those same findings through `buildReviewerPrompt` anyway. Cross-round history is shared by design; same-round peer findings are what the constraint protects, and those are now unreachable.

#### 10.2 The author *is* told

Deduplication and targeted revision are the author's job, so the author's projection carries what §8.1 promises it carries:

```js
// lib/prompts.mjs
function sanitizedFinding(finding)        // unchanged — the reviewer projection (lib/prompts.mjs:23-34)
function sanitizedAuthorFinding(finding) {
  return {
    ...sanitizedFinding(finding),
    raisedBy: finding.raisedBy,          // undefined at N = 1
    dispositions: finding.dispositions,  // undefined at N = 1
    dissent: finding.dissent             // undefined at N = 1
  };
}
```

`collectFindings` populates all three during the round fold, all `undefined` on single-reviewer tasks: `raisedBy = wrapper.meta.reviewerId`; `dispositions = { r1: { status, explanation }, … }` for the latest round that dispositioned the finding; and `dissent = true` when that round's dispositions do not agree on `(status, effectiveSeverity)`. `JSON.stringify` drops `undefined`, so the N = 1 author prompt is byte-identical and its `promptSha256` with it. No branch is needed.

This is what makes §8.1's "surface the disagreement" real rather than a claim: after r1 says `resolved` and r2 says `still_open`, the revising author sees **both explanations** and can target the fix, instead of seeing a bare finding and guessing why its last attempt did not hold.

The asymmetry is deliberate: **the author gets `raisedBy` and `dispositions`; the reviewer gets neither.** Showing a reviewer that F003 came from its peer invites ownership bias ("not mine") on findings it must judge on the merits. Across rounds a reviewer must disposition peers' findings anyway — unavoidable and by design — but it should do so blind to authorship.

#### 10.3 If the human rules the other way (§1.2, §1.4)

Should the ruling favour AC6's letter over enforced independence, the delta is contained and is spelled out here so the ruling does not require a re-plan:

- **§4:** per-slot `reviews/<id>.json` files replace the single `reviews.json`; `reviewFilePaths(taskDir, round, roster)` returns a `Map<slotId, path>`.
- **§6:** the pass invariant is lost. A round's slots can run in different passes, so the round-entry review filter (`meta.round < R`) and the frozen override prefix must both come back, along with `roundOverrideCount` replaying the first-committed slot's count. §8.3's theorem premise reverts from structural to enforced-by-check.
- **§7.2:** ids become path-dependent on failure history (a surviving r2 takes `F001` and a resumed r1 takes `F002`), which must be documented as an accepted property.
- **§5:** `meta.isolation: 'concurrent' | 'resumed'` returns, recording whether a peer artifact was on disk at launch, aggregated as `merge.isolation`.
- **§9:** the "never finalize past a round holding a committed review" guard returns, along with the rule that a partially-reviewed round's findings are visible to `context.findings` and the gate.
- **Verification:** tests 13 and 16 assert the AC6 letter (`r1Provider.calls === 1`, r1's bytes unchanged) and assert, rather than pretend away, that a resumed r2 can read its peer's file.
- **The independence constraint is then documented as partially met** — prompt-level on resumed passes only — which is the claim F001 rejected, and it would be recorded as an accepted requirement-level exception rather than as satisfaction.

### 11. Workflow loop

```js
const roster = reviewerRoster(context.task);
const multiReviewer = roster.length > 1;

// per-slot failure gate, before spending anything
for (const slot of roster) {
  const prior = await failureStatus(context, reviewPhaseKey(roster, slot.id, currentRound));
  if (prior.status === 'needs_human') {
    logger.stage('provider failure limit reached', { phase: 'reviewing', round: currentRound });
    return writeState(context, {
      status: 'needs_human', phase: 'reviewing', round: currentRound, errorClass: 'provider_failure_limit'
    });
  }
}

const overrideCount = (context.overrides.entries ?? []).length;   // captured once, for §5
const prompt = buildReviewerPrompt({                              // one object, every slot, today's arguments
  templates, agentsMd, requirement: context.requirement, plan: author.plan,
  findings: activeFindings(context.findings), closedFindings: closedFindings(context.findings),
  resolutions: author.resolutions, overrides: context.overrides
});

const validated = new Map();
const startedAt = now();
const settled = await Promise.allSettled(roster.map((slot) => invokeWithLimit({
  role: 'reviewer', phase: 'reviewing', round: currentRound,
  provider: providerForSlot(providers, slot), prompt, reviewerId: multiReviewer ? slot.id : undefined,
  schema: schemas.reviewerSchema, schemaFile: schemas.reviewerFile,
  timeoutMs: context.task.reviewerTimeoutMs, logger,
  validate(data) {                                  // exactly today's shape and order
    if (!schemas.validateReviewer(data)) throw validationError('reviewer output', schemas.validateReviewer);
    validated.set(slot.id, validateReviewerOutput(data, {
      round: currentRound, priorReviews: context.reviews, overrides: context.overrides
    }));
  }
})));

// Promise.allSettled resolves index-aligned with its input array, so settled[i] is roster[i]'s
// outcome. That alignment is the only thing tying a provider result to a slot; it is materialized
// once, here, and every consumer below reads the map rather than re-deriving it.
const outcomes = roster.map((slot, index) => ({ slot, outcome: settled[index] }));
const results = new Map(
  outcomes.filter(({ outcome }) => outcome.status === 'fulfilled')
          .map(({ slot, outcome }) => [slot.id, outcome.value])   // invokeWithLimit's { data, meta, attempts }
);
```

For N = 1 this is the same call with the same arguments the code makes today (`lib/workflow.mjs:532-563`), against the same `context.reviews` and `context.overrides`, and `results.get('r1').meta` is the `result.meta` today's line `:571` passes.

**Validation stays inside `validate`, where it is today.** Per §7.1 nothing in it depends on the cursor, so there is no reason to defer it — and deferring it would move the failure *after* `invokeWithLimit`'s `provider attempt completed` log line (`lib/workflow.mjs:161-167`), changing the N = 1 `run.log` event order on the normalization-failure path. Retry semantics are untouched and uniform: each slot invokes `invokeWithLimit` independently, so each slot keeps today's single retry for `retryable` errors and no retry otherwise (`:132-133`, `:173`). A normalize error is neither `retryable` nor an `authorOutputRetry`, so `mayRetry` is false and the first attempt is the last, exactly as today. `invokeWithLimit` still attaches `error.rawOutput` (`:171`) and `error.attempts` (`:184`), so the failure record, `state.json`, and the CLI exit need no reconstruction.

`invokeWithLimit` gains an optional `reviewerId` that it passes through to its `logger.stage` / `heartbeat` / `providerStderr` field objects, appended last. At N = 1 it is `undefined` and `fieldText` drops it (`lib/logger.mjs:4-9`), so every `run.log` line is byte-identical; at N ≥ 2 it is what distinguishes two slots of the same provider in an interleaved log.

`providerForSlot(providers, slot) = providers.reviewers?.[slot.id] ?? providers.reviewer` — so `test/workflow.test.mjs`'s existing `providers: { author, reviewer }` keeps working untouched, and `cli.mjs` supplies `providers.reviewers = { r1, r2, … }` built per slot from its **frozen** model (§2.1), its effort, and its budget. No slot is cancelled when a peer fails: its output is already being paid for, and §11.2 records its provenance.

#### 11.1 Commit: one write, or none

```js
if (outcomes.every(({ outcome }) => outcome.status === 'fulfilled')) {
  let cursor = nextFindingNumberFromReviews(context.reviews);
  const wrappers = [];
  for (const slot of roster) {                       // roster order, deterministic
    const { normalized, coercions, provisionalCursor } = validated.get(slot.id);
    if (!multiReviewer && cursor !== provisionalCursor) throw new Error('single-reviewer id cursor drifted');
    const review = renumberFindings(normalized, cursor);          // identity when N = 1 (§7.1)
    for (const note of coercions) logger.stage('reviewer output normalized', { phase: 'reviewing', round: currentRound, note });
    wrappers.push({ meta: wrapperMeta({ providerMeta: results.get(slot.id).meta, role: 'reviewer',
      round: currentRound, prompt, startedAt, repoRoot, extra: {
        planSha256: sha256(author.plan),
        reviewerId:    multiReviewer ? slot.id : undefined,
        overrideCount: multiReviewer ? overrideCount : undefined } }), review });
    cursor += review.newFindings.length;
  }
  if (multiReviewer) await atomicWriteJson(files.reviews, { schemaVersion: 1, reviews: wrappers });
  else await atomicWriteJson(files.review, wrappers[0]);          // today's exact bytes
  logger.stage('review committed', { phase: 'reviewing', round: currentRound, file: reviewsPathFor(...) });
  continue;
}
```

Each wrapper draws its `meta` and its `review` from the same `slot.id` key — `results.get(slot.id)` and `validated.get(slot.id)` — so a wrapper's provider metadata cannot drift onto a peer's findings. That pairing is asserted, not assumed: tests 7 and 11 use fakes with distinguishable metadata and reversed completion order.

At N = 1 the array is a single wrapper written to `review.json` through the same call today makes, so the file, its `fileSha256`, and the `review committed` log line are unchanged.

#### 11.2 Failure: nothing is committed, provenance is kept

If any slot rejects, **no review is written for the round** — that is the pass invariant, and it is what makes §10.1's guarantee true of resumed passes. The successful slots' output is not silently vaporized:

```json
// rounds/002/discarded.json — append-only, N >= 2 only
{ "schemaVersion": 1, "entries": [
  { "seq": 1, "discardedAt": "…", "reason": "round_not_committed",
    "reviews": [ { "reviewerId": "r1", "meta": { "provider": "codex", "model": "gpt-5.6",
                                                 "promptSha256": "…", "planSha256": "…",
                                                 "usage": {}, "costUsd": null, "…": "…" } } ] } ] }
```

Its entries are built from the same `results` map the commit path uses — `outcomes.filter(({ outcome }) => outcome.status === 'fulfilled')` in roster order, each entry's `meta` taken from `results.get(slot.id).meta` — so a discarded record names the slot that actually produced it.

The record carries **provenance, never judgement**: the wrapper `meta` and nothing else. No problem text, no severity, no finding ids, no verdict — so a reviewer re-run in the next pass can learn nothing about what its predecessor found, and §10.1's guarantee holds with the record sitting in the round directory. The requirement's audit constraint asks that every review stay traceable by provider, model, prompt hash, and `planSha256`; those are exactly the fields kept, so the spend and the identity of a paid-for-but-uncommitted review remain on the record.

Two properties make this simple. It is written **once**, after the pass settles, in a single atomic append — there is no committed body to delete afterwards, so no crash window can leave a stale review and no reconciliation pass is needed. And because ids are stamped only at commit (§7.2), a discarded review reserves no id: the next pass allocates from the same cursor and produces the same ids.

**Per-slot failure accounting (acceptance criterion 6's mechanism).**

```js
function reviewPhaseKey(roster, slotId, round) {
  return roster.length === 1
    ? phaseKeyOf('reviewing', round)              // 'reviewing:001' — unchanged
    : `reviewing:${slotId}:${String(round).padStart(3, '0')}`;
}
```

`state.json.phase` stays the `drafting|reviewing|revising|finalizing` enum; only the failure key is per-slot, and the failure entry carries `reviewerId` (omitted at N = 1). Since `failureCount` filters on an exact `phaseKey` (`lib/workflow.mjs:290-298`), `maxProviderFailures` becomes per-slot: r2 failing twice latches `needs_human` for the task while r1's repeated successes accumulate nothing. This is what bounds §1.2's cost argument — a broken slot stops the task after its second failure, so the healthy slots are re-paid at most once. `resume --clear-failures` remains a global clearance, unchanged.

`handlePhaseFailure` (`lib/workflow.mjs:307-325`) splits into `recordPhaseFailure` (append the record) plus a decision step, so multiple slot failures are all recorded before one verdict is reached: if any slot hit its limit ⇒ `needs_human`; otherwise write `failed` and throw the first rejected outcome in roster order. At N = 1 this is byte-identical to today, including the `phase failed` log fields at `:321`. The failure state is written from the pre-pass context, which is still accurate: nothing was committed, so `context.findings` has not moved.

### 12. Manifest, approval, state, status

**`manifest.json`** — at N = 1 unchanged (`reviewSha256`, `reviewerMeta`; `lib/workflow.mjs:333-343`). At N ≥ 2 it expresses the whole round:

```json
{
  "schemaVersion": 1, "round": 2,
  "authorOutputSha256": "…", "planSha256": "…", "resolutionSha256": "…",
  "authorMeta": {},
  "reviewsSha256": "…",
  "reviewerMetas": [ { "reviewerId": "r1", "…": "…" }, { "reviewerId": "r2", "…": "…" } ],
  "merge": {
    "roundVerdict": "changes_requested",
    "overrideCount": 1,
    "promptShaUniform": true,
    "reviewerVerdicts": { "r1": "approved", "r2": "changes_requested" },
    "newFindingsByReviewer": { "r1": [], "r2": ["F002"] },
    "arbitration": [
      { "findingId": "F001", "outcome": "still_open", "effectiveSeverity": "blocker", "dissent": true,
        "dispositions": { "r1": "resolved", "r2": "still_open" } }
    ]
  },
  "completedAt": "…"
}
```

The manifest stays a pure audit summary, never load-bearing. `writeManifest`'s early return becomes `if (!author || !wrappers.length) return` — and because a round has reviews only if it is complete, `merge.reviewerVerdicts` always covers the whole roster and §8.3's unanimity corollary always applies. `merge` is computed from all review history through the round under `entries.slice(0, merge.overrideCount)`, so the manifest is self-describing: a reader reproduces `roundVerdict` from the review file plus `overrides.json` without knowing when anything happened.

`merge.promptShaUniform` records whether the round's wrappers share a `promptSha256`. Under §1.3 they always do — one pass, one prompt object — so divergence can only come from a hand-edited artifact. It stays a **warning recorded in the manifest, never a load failure**: bricking a task over a hash mismatch in an audit-only field would be a worse bug than the one it detects.

**`approval.json`**:

- `expectedApprovalFields` returns `reviewSha256: fileSha256(review.json)` at N = 1 and `reviewsSha256: fileSha256(reviews.json)` at N ≥ 2. Both are scalars, so `validateApproval`'s `!==` comparison (`lib/workflow.mjs:364`) and `finalize`'s (`:399`) are **unchanged**, as is the `approval.json has an invalid ${key}` message. `overridesSha256` (`:357`) is unchanged and keeps binding the **live** set — the gate's override set, per §8.3's table.
- `gate.verdict` stays the constant `'approved'` and `gate.overrides` stays `context.overrides.entries` — both unchanged. `gate` gains `reviewerVerdicts: { r1, r2 }` at N ≥ 2, defined as **the raw stored verdict of each slot in the approved round, whatever it is**. These are audit facts, not assertions: per §8.3 an approval built on human overrides legitimately records `changes_requested` here, and `gate.overrides.length > manifest.merge.overrideCount` is then guaranteed and is where the explanation lives. Nothing validates them against `approved` — `gate` is not among `expectedApprovalFields`.
- The published provenance line uses `reviewer=codex` at N = 1 (unchanged) and `reviewers=r1:codex/gpt-5.6,r2:claude/claude-opus-4-8` at N ≥ 2 (`lib/workflow.mjs:406`), naming the frozen models because §2.1 guarantees they exist.

**`state.json`** is unchanged in shape. There is no `pendingReviewerIds`: a round's reviews are all-or-nothing, so "which slots are pending" is never a durable state — a failed pass leaves the round unreviewed, exactly as at N = 1, and the failure records name the slot that broke.

**`inspectTask`** (`lib/workflow.mjs:593-636`) adds `raisedBy` and `dispositions` per blocking finding, both sourced from fields `collectFindings` leaves `undefined` at N = 1 — so the N = 1 status JSON is byte-identical, while N ≥ 2 shows the human every reviewer's position on a dissented finding. Its failure aggregation generalizes: for the current round it queries `failureStatus` per slot and folds — **any slot at its limit ⇒ `needs_human`; otherwise any failed slot ⇒ `failed`; otherwise `running`.** At N = 1 that fold is a single key lookup returning today's answer (`:634`). Without this, a `status` run after `state.json` loss would report `running` while `runWorkflow` correctly reports `failed`. The existing per-finding `override` field (`:611`) continues to show when a human ruling superseded arbitration.

**`overrides.json`** gains nothing and its writer is untouched. This change *depends* on `applyOverride` remaining append-only (§8.3), so that property gets an explicit comment at the push site (`lib/workflow.mjs:679`) and a line in `docs/design.md`: editing or removing an entry retroactively rewrites every round snapshot that recorded a count spanning it.

**`task.json`** is written by exactly two functions: `initializeTask` (§2, §2.1) and `updateTaskSettings` (§3.2). Both respect the mutually exclusive shape rule.

### 13. Docs

`docs/design.md`: a new §4.4 covering the roster, arbitration, the three verdicts and the composition theorem, id allocation, partial-failure behavior, and the Q1–Q3 answers. §4.2's "recomputes the expected verdict from finding state" is corrected to "from the reviewer's own local view under the round's override set". §2 (layout), §6 (CLI), §7 (anti-livelock: the streak counts rounds, not reviews), and §9 (tests) are updated.

§4.4 must state explicitly, because these are the most misreadable parts of the design:

- **the requirement conflict of §1 and the ruling taken** — that enforced independence and AC6's letter are provably incompatible while provider adapters are unchanged, that the enumeration in §1.1 (relocation, obscurity, encryption, keychain, mode `0000`, read jail) leaves no enforceable alternative, that this design keeps independence, and that a failed reviewer pass therefore re-runs the whole roster;
- that a round's reviews are **one atomic commit**, that this is what makes independence enforceable, and that the cost is a failed pass discarding its successful slots' output (provenance retained in `discarded.json`), narrowed by the existing per-slot in-pass retry for transient errors;
- each of the three verdicts with **both** its review set and its override set named;
- that a reviewer's stored verdict is an audit fact about the state it saw, and that an approval may contain `changes_requested` reviewer verdicts whenever `gate.overrides.length > merge.overrideCount` explains it;
- that the round's override snapshot is a **count**, valid only because `applyOverride` is append-only, and that hand-editing `overrides.json` retroactively invalidates recorded snapshots;
- that a roster slot's **model is resolved once at task creation and frozen**, that a slot may not run on a provider CLI's built-in default, and why (`meta.model: null` is untraceable and env re-resolution is unfrozen);
- the resume-time mutability rule: on a roster task, timeouts are mutable and slot models and efforts are frozen;
- that N has **no hard maximum**, that above four slots `run` warns and proceeds, and that slots are never throttled.

`README.md`, `SKILL.md`, `integrations/codex/plan-forge.md`: `--reviewers`; the collision rule from §3.1 stated as "at least one reviewer must differ from the author"; that a roster slot must name a model or supply one through the provider's env var, and that `--reviewer-model` / `--reviewer-effort` are single-reviewer-only; that any N ≥ 1 is accepted and large rosters warn rather than fail; and the cost note — N reviewers means roughly N× reviewer spend per round at unchanged wall-clock (slots run concurrently, so a round costs `max` time, not `sum`), and a failed reviewer pass re-runs the whole roster on resume, bounded by `--max-provider-failures`. `CHANGELOG.md`.

## Verification

### The existing suite

**A note on the count.** The requirement says "the existing 31 tests". The suite on disk today has **39** tests across nine files (`node --test test/*.test.mjs`, per `package.json:10`) plus one opt-in live test (`test/live.test.mjs`, gated on `PLAN_FORGE_LIVE=1`): findings 10, workflow 12, logging 5, schema 3, prompts 2, artifacts 2, doctor 2, packaging 2, providers 1. The working tree carries uncommitted test additions, which is where the drift comes from. The requirement's intent is unambiguous and is what I hold myself to: **no existing test is modified and none regresses**, against the current suite whatever its count.

The design is shaped around that. `collectFindings` and `normalizeReviewerOutput` keep their signatures and input shapes (`test/findings.test.mjs`); `runWorkflow` still accepts `providers: { author, reviewer }` (`test/workflow.test.mjs`); `updateTaskSettings` keeps its signature and N = 1 semantics including the `invalid effort "max" for codex` rejection (`test/workflow.test.mjs:265-285`); `buildReviewerPrompt` / `buildAuthorPrompt` keep theirs (`test/prompts.test.mjs`). `test/workflow.test.mjs:297-323` ("human override closes a blocker without rewriting review history") is the specific existing test that pins §8.3's separation of reviewer verdicts from the gate verdict; if it needs editing, the change is wrong. **Any diff to an existing test file is a signal the change drifted from the backward-compatibility constraint and must be justified, not accepted.**

### New tests

`test/findings.test.mjs` — merge semantics and arbitration:

1. **Arbitration table.** For a `blocker` F001 with two dispositions, assert the fold over: `(resolved, still_open)` ⇒ open/`still_open`/blocker; `(resolved, resolved)` ⇒ closed/`resolved`; `(withdrawn, withdrawn)` ⇒ closed/`withdrawn`; `(withdrawn, resolved)` ⇒ closed/`resolved`; `(still_open, severity_changed→minor)` ⇒ open/`still_open`/blocker; `(severity_changed→major, severity_changed→minor)` ⇒ open/`severity_changed`/major; `(resolved, severity_changed→major)` ⇒ open/`severity_changed`/major; `(severity_changed→minor, severity_changed→nit)` ⇒ open/minor/non-blocking. Also assert `lastExplanation` is the winner's and that ties break to the earlier slot.
2. **The streak advances once per round, not once per review.** Two reviewers both `still_open` in round 2 ⇒ `criticalReviewStreak === 1` and `hasStalledCriticalFinding === false`. The regression guard for the latent bug in §8; it fails loudly against a naive fan-out.
3. **Composition theorem.** Over an enumerated matrix of two-reviewer rounds, assert per row that `blockingFindings(merged)` ids equal the union of `blockingFindings(local_i)` ids, and that `roundVerdictOf === 'approved'` ⟺ both stored verdicts are `approved`. Run the matrix twice: once with an empty override set, and once with **an override already in force at round entry** — round 1 raises blockers F001 and F002, O001 withdraws F001, the round-2 pass records `overrideCount: 1`, its reviewers disposition only F002 and both resolve it; assert `roundVerdictOf(2) === 'approved'` and that unanimity holds. Under an override-free reconstruction this row yields `changes_requested` against two `approved` reviewers, so it is the regression guard for §8.3's central claim.
4. **Overrides beat arbitration.** A finding held open by conservative arbitration at `blocker` plus a `withdrawn` override ⇒ closed, `lastStatus === 'withdrawn'`, `criticalReviewStreak === 0`, and the per-reviewer `dispositions` still readable on the finding. Confirms `applyOverrides` stays last and stays authoritative.
5. **Cursor, renumber, and roster ordering.** `nextFindingNumberFromReviews` maxes over every wrapper of every round. `renumberFindings` is the identity when `cursor === provisionalCursor`; at a shifted cursor it remaps ids order-preservingly **and** rewrites a `relatedToFindingId` pointing inside the same review's provisional block, while leaving one pointing at a round-entry id alone. Two slots validated against the same `before` map produce colliding provisional ids and disjoint committed ids `F001,F002` / `F003`. Finally, with wrappers labelled `r2` and `r10` in one round, assert the fold applies `r2` first — §8's numeric roster index, which a `localeCompare` implementation fails now that §2 imposes no cap.

`test/workflow.test.mjs` — fan-out, using an extended `test/helpers.mjs` (`initTask` accepting `reviewers`, `runtime` accepting `providers.reviewers`, and a barrier-gated `fakeProvider` whose `invoke` resolves only once every slot has entered it):

6. **Concurrency is real.** The barrier fake deadlocks (and the test times out) if slots are invoked sequentially; passing proves fan-out.
7. **Two reviewers, disjoint findings, correctly paired metadata.** r1 raises two, r2 raises one ⇒ `rounds/001/reviews.json` exists with two wrappers in roster order, no `review.json`, ids are `F001,F002` (r1) and `F003` (r2) **regardless of which fake resolves first** (assert by running the same scenario with reversed completion order), and round 2's author prompt carries all three with `raisedBy`. Assert each wrapper's `meta.provider`, `meta.model`, and `meta.sessionId` are **its own slot's** — the two fakes return distinguishable metadata, so a slot/result mix-up in §11's `results` map fails here rather than silently mislabelling the audit chain.
8. **Conflict arbitration end to end.** r1 `resolved` / r2 `still_open` on a blocker ⇒ the round stays `changes_requested`, the author is asked to revise, `inspectTask` reports both dispositions and `dissent: true`, and `manifest.merge.arbitration` records the same. Assert the round-2 **author prompt contains r2's explanation text** — the executable form of §10.2, and the guard against the projection promising what it does not carry.
9. **Unanimity approves.** Both reviewers approve ⇒ `approved`; `approval.json` has `reviewsSha256` matching `fileSha256(reviews.json)`, `gate.reviewerVerdicts` is `{ r1: 'approved', r2: 'approved' }`, `gate.overrides` is empty, `manifest.merge.roundVerdict === 'approved'` with `merge.overrideCount === 0`, and `docs/plans/<id>.md` provenance names both slots with their frozen models.
10. **Approval over reviewer dissent, via override.** r1 `approved` / r2 `changes_requested` on a blocker at `maxRounds` ⇒ `needs_human`; `applyOverride --disposition withdrawn` ⇒ resume returns `approved` **without re-invoking either reviewer**. Assert `reviews.json` is byte-unchanged and r2's stored `verdict` is still `changes_requested`; `gate.reviewerVerdicts` is `{ r1: 'approved', r2: 'changes_requested' }`; `gate.verdict === 'approved'`; `gate.overrides` contains O001; `merge.roundVerdict === 'changes_requested'` and `merge.overrideCount === 0` are both unchanged by the override; and §8.3's relationship holds numerically — `gate.overrides.length > merge.overrideCount`. The multi-reviewer analogue of `test/workflow.test.mjs:297-323`.
11. **A failed pass commits nothing and keeps provenance (§11.2).** r2's provider throws a non-retryable error while r1 succeeds ⇒ **no `reviews.json` exists**; `rounds/001/discarded.json` has one entry whose `reviews[0]` is **r1** with r1's own `meta.provider`, `meta.model`, `meta.promptSha256`, `meta.planSha256`, and `meta.usage` (the fakes' metadata is distinguishable, so a slot/result mix-up fails here), and which contains **no** `problem`, `severity`, `verdict`, or finding-id field (asserted by scanning the serialized entry, not just by reading known keys); `state.json` is `failed` with today's shape and no new keys. This is the honest, executable statement of §1.2's cost.
12. **Resume after a failed pass re-runs the roster (§1.2's ruling, AC6's letter deliberately not met).** Continuing test 11: resume ⇒ `r1Provider.calls === 2` and `r2Provider.calls === 2`, the round completes in one `reviews.json`, ids are allocated in roster order from the same cursor as if no failure had occurred (assert against the same scenario run with no failure — **byte-identical finding ids**, the executable form of §7.2's path-independence), and `discarded.json` still holds exactly the one entry from the failed pass. Separately, assert the narrowing in §1.2: when r2 fails with a **`retryable`** error and succeeds on its second attempt, the pass commits normally and `discarded.json` is never created — `r1Provider.calls === 1`, so the transient case costs nothing.
13. **Per-slot failure limit and status reconstruction.** r2 fails twice ⇒ `needs_human` with `errorClass: 'provider_failure_limit'`; delete `state.json` and assert `inspectTask` still reports `needs_human` (the §12 aggregation); `resume --clear-failures` then completes the round. Assert r1's repeated successes never accumulate a failure under its own phase key, which is what bounds §1.2's re-pay argument.
14. **Isolation is enforced, on the first pass and on the resumed pass (§10.1).** A probe fake provider that, inside `invoke`, lists `rounds/001/` and reads anything matching `review*.json`, recording what it finds. Assert that on the first pass both slots observe **no review artifact of round 1**; then, after a partial failure and a resume, assert that both re-run slots **again** observe none — including that `discarded.json`, if the probe reads it, contains no finding content. This is the whole of §10.1's guarantee, and it fails against any design that commits a peer's review before the round completes. It is the test F001 asked for.
15. **Prompt asymmetry.** At N = 2 the reviewer prompt contains no `raisedBy`, no `dispositions`, and no peer mention, and both slots receive a byte-identical prompt. The author prompt contains all three. At N = 1 neither prompt contains any of them.
16. **Stall bound under conservative arbitration.** One reviewer resolves every round while the other holds `still_open` ⇒ `needs_human` at round 3 via `criticalReviewStreak === 2`, not an indefinite loop. The executable form of the Q1 argument; test 10 covers the override that then approves.
17. **Legacy resume.** Hand-write a task with `reviewer: 'codex'` and a committed `rounds/001/review.json` whose `meta` has no `reviewerId` or `overrideCount`; resume completes without re-invoking the reviewer.
18. **Roster is frozen and validated.** `resume --reviewers …` is rejected; a hand-edited `task.json` carrying both `reviewer` and `reviewers` is rejected; ids other than `r1..rN` are rejected; an invalid legacy `task.reviewer` still fails with today's exact `task.json requirement identity is invalid`.
19. **Round artifact corruption is rejected (§9).** On a two-slot task: a `reviews.json` missing r2's wrapper ⇒ `round 1 reviews.json does not match the roster`; wrappers out of roster order ⇒ same; a wrapper whose `meta.provider` disagrees with its slot ⇒ rejected; a wrapper whose `meta.model` disagrees with the frozen slot model ⇒ rejected; wrappers disagreeing on `meta.overrideCount` ⇒ `round 1 reviews disagree on their override snapshot`; `meta.overrideCount` of `-1` **and** of `entries.length + 1` ⇒ both rejected (the negative case fails against a one-sided `k <= length` bound, which would silently `slice(0, -1)`); a hand-edited divergent `promptSha256` ⇒ the round still loads and completes with `merge.promptShaUniform === false` and a warning, never a load error.
20. **Approval binds the last complete round, and an unreviewed round is still discarded.** Two-slot task, `maxRounds: 3`. (a) Round 1 raises blocker F001; round 2 completes with both reviewers holding F001 `still_open`; a human withdraws F001 and resumes ⇒ approval binds **round 2** (`approval.round === 2`, `planSha256 === sha256(round 2 plan)`, `reviewsSha256 === fileSha256(rounds/002/reviews.json)`) with no reviewer re-invoked. (b) Negative control, today's N = 1 behavior preserved at N = 2: round 2 authored but **unreviewed**, the same override ⇒ finalize round 1 and discard round 2's author output.
21. **N = 1 normalization-failure ordering.** A single-reviewer round whose provider returns schema-valid output that fails normalization (a `previousFindings` entry for an unknown id, so `missing`/`extra` throws). Assert against a captured logger that the event sequence is `provider attempt started` → `provider attempt failed` → `phase failed` with **no `provider attempt completed` between them**, and that the failure record carries `errorClass: 'workflow_error'`, `attempts: 1`, and the raw output — all identical to `main`. Run the same assertion with a two-slot roster to confirm the ordering is uniform rather than special-cased.
22. **A roster task survives an unrelated settings update (§3.2).** On a two-slot task (`codex:gpt-5.6@xhigh,claude:claude-opus-4-8@max`), call `updateTaskSettings({ reviewerTimeoutMs: 1800000 })`. Assert on both the return value and the re-read `task.json`: `reviewerTimeoutMs` is updated; **no `reviewerEffort`, `reviewerModel`, or `reviewer` key exists** (`assert.ok(!('reviewerEffort' in persisted))` — not merely falsy, since the bug writes `null`); `reviewerRoster(persisted)` returns the same two slots with unchanged models and efforts; and a subsequent `runWorkflow` resume loads the task and reaches the review phase. Repeat for `authorTimeoutMs` and `authorEffort`, both of which must keep working on a roster task. Against the unfixed function this fails on the `in` assertion.
23. **Per-slot effort is rejected, not silently corrupted (§3.2).** On the same task, `updateTaskSettings({ reviewerEffort: 'xhigh' })` rejects with `/--reviewer-effort applies only to single-reviewer tasks/` and `task.json` is **byte-unchanged** (the throw precedes `atomicWriteJson`), asserted by capturing the bytes before and after. Assert the message is the actionable one, not `unsupported provider undefined`.
24. **Roster models are frozen at creation (§2.1).** With `PLAN_FORGE_CODEX_MODEL=gpt-5.6` set, `initializeTask` with `--reviewers 'codex,claude:claude-opus-4-8'` persists `reviewers[0].model === 'gpt-5.6'` in `task.json`. Then **change the env var** to another value and resume: assert the codex slot is still invoked with `gpt-5.6` (captured from the provider factory arguments) and that a hand-edited `reviews.json` whose `meta.model` carries the new value is rejected by the loader. With the env var **unset** and no explicit model, `initializeTask` throws `/roster slot r1 \(codex\) has no model/` and writes no `task.json`. Assert the same rule fires for a modelless claude slot. Finally, assert the legacy path is untouched: a `--reviewer codex` task with no model and no env var still initializes and still runs with `model: null`, exactly as today.

`test/artifacts.test.mjs`:

25. `reviewsPathFor` returns the legacy `review.json` for a one-slot roster and `reviews.json` for multi-slot; `roundPaths` keeps its existing keys; task-id traversal rules still hold for the new file names.

`cli` parsing (`test/schema.test.mjs` or a new `test/cli.test.mjs`):

26. **Spec parser, roster size, and collision rule.** `codex:gpt-5.6@xhigh,claude:claude-opus-4-8` parses to the expected slots; last-`@` / first-`:` splitting; unknown provider, bad effort, empty entry, and an empty spec all throw; `--reviewer` together with `--reviewers` throws; `--reviewers codex` normalizes to the legacy scalar shape (and is therefore exempt from §2.1's model rule). For §2's unbounded domain: **a five-slot roster parses and initializes, warning rather than throwing** (the guardrail is advisory, not a domain restriction), and a ten-slot roster parses with ids `r1..r10` — both would fail against a hard cap. For §3.1: `author=claude, reviewers=codex:gpt-5.6,claude:claude-opus-4-8` is **accepted without `--allow-same-provider`**; `author=claude, reviewers=claude:a,claude:b` is rejected without it; `author=claude, reviewer=claude` is rejected without it and `author=claude, reviewer=codex` accepted, exactly as today; and two slots with the same frozen `(provider, model)` **warn without failing**.

### The byte-for-byte regression guard

27. The decisive test for the backward-compatibility constraint. Run the existing N = 1 approval flow and assert **exact key sets and order** on `rounds/001/review.json`'s `meta` (no `reviewerId`, no `overrideCount`), `manifest.json` (`reviewSha256` / `reviewerMeta`, no `merge`, no `reviewsSha256`), `approval.json` (`reviewSha256`, no `reviewsSha256`; `gate` with no `reviewerVerdicts`), `state.json`, `task.json` **after a resume-time `updateTaskSettings` call** (§3.2's conditional spread must not reorder or drop a key), and the `inspectTask` JSON (no `raisedBy` / `dispositions`) — plus `buildReviewerPrompt` / `buildAuthorPrompt` hashes against a fixture captured from `main`, and the full `run.log` line sequence (proving the `reviewerId: undefined` log field is invisible). Include one N = 1 run **with an override in the log** to prove the reviewer prompt is byte-identical to `main`'s. Together with test 21, which covers the failure path, this turns "byte-for-byte unchanged" from an intention into an enforced invariant across the success path, the failure path, the override path, the log, and the settings-update path — and it is the test most likely to catch a careless `undefined`-vs-`null` slip in §3.2, §5, or §10.2, including the `overrideCount: 0` ternary that a `count || undefined` would silently drop.

### Acceptance criteria

| Requirement AC | Where it is met | Proven by |
|---|---|---|
| 1 — N ≥ 1 concurrent; N = 1 as today | §2 roster with **no hard cap** (large rosters warn, never fail), §3.2 shape-safe settings updates, §4 layout, §11 fan-out | 6, 7, 9, 17, 21, 22, 23, 24, 26, 27, full existing suite |
| 2 — race-free, deterministically ordered ids | §7.2 single-pass commit from a file-seeded cursor in roster order; path-independent with no caveat | 5, 7, 12 |
| 3 — defined, justified arbitration | §8.1 conservative fold + the Q1 argument | 1, 4, 8, 16 |
| 4 — explicit verdict composition | §8.3 three verdicts each with its review **and** override set, the theorem, the unanimity corollary, the exact gate/round relationship | 3, 9, 10 |
| 5 — every finding traceable | §4 `meta.reviewerId`, §2.1 frozen model, §11 the slot→result map, §12 manifest | 7, 8, 11, 19, 24 |
| **6 — resume re-runs only the failed slot** | **NOT MET in letter — §1.1 proves it is incompatible with enforced independence while provider adapters are unchanged, enumerating every alternative (relocation, obscurity, encryption, keychain, mode `0000`, read jail) and why each fails to enforce or is the forbidden non-goal; §1.2 recommends keeping independence; §1.4 states the handoff; §10.3 specifies the delta if the human rules otherwise.** Met in purpose: resume completes the round, loses no committed decision, and re-runs the failed slot; the successful slots are re-invoked and their earlier provenance is retained. The window is narrower than the criterion implies — transient slot failures are already rescued in-pass by `invokeWithLimit`'s existing retry, so no peer output is discarded for them. **Requires a human ruling.** | 11, 12, 13 assert the actual behavior rather than the criterion |
| 7 — existing tests green; merge and conflict arbitration covered | signature preservation throughout | full suite + 1–27 |
| Constraint — reviewer independence | §1.3 pass invariant, §10.1 unchanged reviewer prompt; enforced at every N on every pass | 14, 15 |
| Constraint — audit chain unbroken | §5 wrapper meta, §11.2 discarded-review provenance, §12 manifest / approval / state | 9, 10, 11, 14, 27 |

### Manual verification

`node --test test/*.test.mjs` for the zero-cost suite, then one opt-in live run with a real heterogeneous roster:

```bash
plan-forge run --task concurrent-reviewers-smoke \
  --requirement docs/requirements/<x>.md \
  --author claude --reviewers 'codex:gpt-5.6,claude:claude-opus-4-8'
```

That command runs as written — no `--allow-same-provider` — which is itself the check on §3.1, and both slots name a model, which is the check on §2.1. Confirm from `.plan-forge/<task>/rounds/001/`: one `reviews.json` with two wrappers; identical `meta.promptSha256`, `meta.planSha256`, and `meta.overrideCount` across them; distinct `meta.provider` / `meta.model`, each equal to its frozen roster slot; disjoint finding ids; and a `manifest.json` whose `merge.arbitration` matches what `plan-forge status` reports and whose `merge.roundVerdict` is `approved` exactly when both `merge.reviewerVerdicts` are. Then `plan-forge resume --task concurrent-reviewers-smoke --reviewer-timeout 1800` and confirm the task still loads with its roster intact (§3.2), while `--reviewer-effort xhigh` is rejected with the actionable message. Finally, verify that the whole point of the change actually landed: that the union of the two reviewers' findings is larger than either alone.

---

## Appendix: Frozen Requirement

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

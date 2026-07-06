<!-- plan-forge: task=inject-context round=1 author=codex reviewer=claude approvedAt=2026-07-06T15:06:38.249Z planSha256=476c91425ee7674cd7719faf4c1e2865714e99f51bcf228c3e40da1cc0b464c8 requirementSha256=ec1d955ddd3e00b04f21c3d8120e77515d13fd7e8de090fff207c20fb47b51f2 -->

# Context Injection Option Plan

## Goal

Add a repeatable `run --inject <path>` option that freezes an ordered list of repository-relative context files into `.plan-forge/<task>/task.json`, then re-reads those files before every Author and Reviewer provider call. The injected content must be rendered with the same delimiter format in both prompts, audited in wrapper metadata with SHA-256 hashes, rejected before task creation when invalid, and reused on `resume` without requiring or accepting new `--inject` flags.

## Implementation

1. Extend CLI option handling in `cli.mjs`.

- Update `parseArgs` so `--inject <path>` is repeatable instead of overwritten by the last occurrence. Store it as an array in the original command-line order for both `--inject value` and `--inject=value` forms.
- Add a scalar size option named `--inject-max-bytes <n>` on `run`, parsed with `numberOption`. Use a default exported from workflow code, e.g. `DEFAULT_INJECT_MAX_BYTES = 128 * 1024`.
- Add `injectPaths` and `injectMaxBytes` to `taskOptions(values)`.
- On `resume`, reject `--inject` and `--inject-max-bytes` with a clear error such as `--inject is only valid on run; resume uses the injected files persisted in task.json`.
- Document the new options in `README.md` and, if keeping `docs/design.md` current is expected for this repo, add the new task metadata and prompt/meta audit behavior there too.

2. Persist normalized injection configuration during task initialization in `lib/workflow.mjs`.

- Add task fields:
  - `injectPaths`: array of normalized repository-relative paths, in the exact order supplied by `run`.
  - `injectMaxBytes`: positive integer cap used when validating injected content.
- Keep `schemaVersion: 1` for compatibility. Existing tasks without these fields should load as `injectPaths: []` and `injectMaxBytes: DEFAULT_INJECT_MAX_BYTES`.
- Add a helper such as `validateInjectedFilesAtInit({ repoRoot, injectPaths, injectMaxBytes })` that runs before `task.json`, `requirement.md`, or `overrides.json` is written.
- For each supplied path:
  - Accept relative paths and absolute paths only if they resolve inside the target repo.
  - Resolve from `repoRoot`, normalize the persisted path to repo-relative slash-separated form, and preserve order.
  - Use `fs.realpath` on both repo root and candidate file so symlinks that point outside the repository are rejected.
  - Reject missing paths, directories, duplicate normalized paths, and paths escaping the repo with clear errors naming the path.
  - Read each file as UTF-8 and sum `Buffer.byteLength(content, 'utf8')` across the list.
  - If the total exceeds `injectMaxBytes`, fail with an error naming the limit, e.g. `injected content exceeds --inject-max-bytes limit of 131072 bytes`.

3. Re-read injected files for every provider invocation.

- Add a runtime helper such as `loadInjectedContext({ repoRoot, task })` in `lib/workflow.mjs` or a small shared module.
- It should use only `task.injectPaths` from `task.json`; `resume` and `runWorkflow` must not receive injection paths from transient CLI state.
- On each call, read the current file contents from disk, recompute SHA-256, byte size, and total bytes, and re-run inside-repo and regular-file validation. This handles repository changes between invocations while still preventing prompt blowups or symlink escapes.
- If a persisted injected file is deleted, retargeted outside the repo, changed to a directory, or grows beyond the cap, throw before `provider.invoke`. Do not record this as a provider failure or spend model tokens; the user can fix the repository and run `resume` again.

4. Render injected content in both prompts with one shared formatter in `lib/prompts.mjs`.

- Extend `buildAuthorPrompt` and `buildReviewerPrompt` to accept `injectedContext`, defaulting to an empty list for existing tests/callers.
- Insert the injected block immediately after `PROJECT AGENTS.MD` and before `FROZEN REQUIREMENT` so it is authoritative project context alongside AGENTS.md.
- Use one shared renderer for both roles so Author and Reviewer prompts are structurally identical for injected context. Suggested format:

```text
===== BEGIN INJECTED PROJECT CONTEXT =====
===== BEGIN INJECTED FILE docs/a.md =====
sha256: <hex>
bytes: <n>
<file content exactly as read>
===== END INJECTED FILE docs/a.md =====
===== END INJECTED PROJECT CONTEXT =====
```

- Preserve file content instead of trimming it. Add only the delimiter newlines needed to keep block boundaries unambiguous.
- If no files are injected, omit the injected context block to avoid changing current prompts for existing tasks.

5. Add injected-file audit data to wrapper metadata.

- Extend `wrapperMeta` to accept injected audit data and add:
  - `injectedFiles`: array of `{ path, sha256, bytes }` in persisted order.
  - `injectedTotalBytes`: summed byte count.
- Immediately before building each Author or Reviewer prompt in `runWorkflow`, call `loadInjectedContext`, pass it into the prompt builder, and pass the same audit object into `wrapperMeta`.
- The wrapper `promptSha256` will then naturally bind to the exact prompt that included the injected content, while `injectedFiles` makes the file list and hashes directly auditable.
- Existing manifest writing already embeds `authorMeta` and `reviewerMeta`, so no separate manifest schema change is needed beyond the richer metadata.

6. Preserve existing data flow and immutability rules.

- `initializeTask` remains the only place that creates task-level artifacts.
- Provider calls remain read-only; injected files are read by the orchestrator only.
- `resume` continues to reconstruct state from `task.json` and round artifacts. It never accepts a replacement injection list.
- Approved-plan publishing does not need to append injected content; the audit path is task metadata plus per-invocation wrappers.

Failure handling acceptance criteria:

- Missing injected file during `run` initialization: command fails before task creation and before any provider call.
- Escaping path or symlink target outside repo: command fails before task creation and before any provider call.
- Total content over cap at initialization: command fails before task creation with the configured byte limit in the message.
- Injected file changes after task creation: next provider invocation re-reads it, records the new hash if valid, or fails before model spend if invalid/over cap.
- `resume --inject ...`: fails clearly rather than silently changing or ignoring context.

## Verification

Use `node:test` and fake providers; run `npm test` after implementation.

1. Prompt unit coverage in `test/prompts.test.mjs`.

- Build both Author and Reviewer prompts with the same `injectedContext` and assert both include `BEGIN INJECTED PROJECT CONTEXT`, each file delimiter, file contents, and no process environment leakage.
- Assert injected blocks appear after `PROJECT AGENTS.MD` and before `FROZEN REQUIREMENT`.
- Assert ordering follows the persisted list exactly.

2. Workflow fake-provider coverage in `test/workflow.test.mjs`.

- Update `fakeProvider` in `test/helpers.mjs` to capture invocation prompts, e.g. `prompts[]`, while preserving existing behavior.
- Create `docs/a.md` and `docs/b.md`, initialize with `injectPaths: ['docs/a.md', 'docs/b.md']`, approve a one-round workflow, and assert:
  - Author and Reviewer prompts both contain both files.
  - `docs/a.md` appears before `docs/b.md` in both prompts.
  - `author-output.json.meta.injectedFiles` and `review.json.meta.injectedFiles` list both paths and the expected SHA-256 values.

3. Rejection coverage.

- Missing file: `initializeTask` rejects and no `task.json` exists.
- Traversal: `../outside.md` rejects and no `task.json` exists.
- Symlink escape: an injected symlink inside the repo pointing outside rejects.
- Cap enforcement: initialize with a small `injectMaxBytes` and content larger than the cap; assert the error names the byte limit and no provider is called.

4. Resume persistence coverage.

- Initialize a task with `injectPaths: ['docs/context.md']`.
- Run until an Author output is committed and Reviewer fails with a fake provider error.
- Modify `docs/context.md`, then call `runWorkflow` again with no new injection options.
- Assert the Reviewer prompt still includes `docs/context.md`, includes the modified content, and `review.json.meta.injectedFiles[0].sha256` matches the modified file. This proves the list is persisted while content is re-read per invocation.

5. CLI option coverage.

- Add a small unit test for the parser or extracted option helper so `--inject docs/a.md --inject=docs/b.md` produces `['docs/a.md', 'docs/b.md']` rather than overwriting.
- Add a test or direct assertion that resume-time `--inject` is rejected with the persisted-list message if CLI internals are made testable.

6. Regression coverage.

- Existing tests for approval recovery, provider failure handling, inline requirements, custom publish dir traversal, and prompt construction must keep passing.
- Acceptance is met when `npm test` passes and the new tests demonstrate injection presence, deterministic ordering, traversal/missing rejection, cap enforcement, wrapper metadata hashes, and resume persistence.

---

## Appendix: Frozen Requirement

# Context injection option (--inject)

## Goal

Let users designate repository files whose content is explicitly injected into both the Author and Reviewer prompts as authoritative project context, alongside the AGENTS.md injection that already exists. This gives planning-critical conventions (architecture notes, API guidelines) a deterministic, audited path into the loop instead of relying on models discovering them via Read.

## Constraints

- New repeatable CLI option `--inject <path>` on `run`, persisted per task in task.json; resume uses the persisted list unchanged.
- Every injected path must resolve inside the target repository; reject traversal at task initialization, before any model call.
- Injected content appears in fixed delimited blocks in BOTH the author and reviewer prompts, identically, and is re-read from disk at each invocation (the repository is not frozen).
- Each invocation records the injected file list with per-file SHA-256 in the wrapper meta for audit.
- A total-size cap on injected content (configurable option with a sensible default) fails fast at init when exceeded.
- Follow the existing code style: orchestrator-only writes, immutability, node:test coverage.

## Acceptance criteria

1. `run --inject docs/a.md --inject docs/b.md` injects both files into both prompts in deterministic order.
2. A path outside the repository or a missing file fails task creation with a clear error and no model spend.
3. Exceeding the size cap fails task creation with a clear error naming the limit.
4. Wrapper meta of every author/reviewer invocation lists injected paths and their hashes.
5. Resume after interruption reuses the persisted inject list without re-specifying it.
6. Fake-provider tests cover injection presence, ordering, traversal rejection, cap enforcement, and resume persistence.

## Non-goals

- No glob expansion in v1 (explicit file paths only).
- No per-role (author-only / reviewer-only) injection in v1.
- No change to the AGENTS.md handling or the read-only provider model.

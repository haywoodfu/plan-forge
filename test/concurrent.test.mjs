import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { sha256 } from '../lib/artifacts.mjs';
import { ProviderError } from '../lib/process.mjs';
import { loadPromptTemplates } from '../lib/prompts.mjs';
import { loadSchemas } from '../lib/schema.mjs';
import { applyOverride, inspectTask, runWorkflow } from '../lib/workflow.mjs';
import { fakeProvider, initTask, plan, tempRepo, toolRoot } from './helpers.mjs';

const TWO_SLOTS = [
  { provider: 'codex', model: 'gpt-a', effort: null, claudeMaxBudgetUsd: null },
  { provider: 'codex', model: 'gpt-b', effort: null, claudeMaxBudgetUsd: null }
];

function newBlocker(problem = 'the plan is incomplete') {
  return {
    id: null, relatedToFindingId: null, relationKind: null, noveltyRationale: 'new correctness issue',
    severity: 'blocker', category: 'correctness', planSection: 'Implementation',
    problem, evidence: ['src/a.js'], requiredChange: 'add the missing behavior'
  };
}

const approveEmpty = { verdict: 'approved', previousFindings: [], newFindings: [], summary: 'clean' };
const blockerReview = { verdict: 'changes_requested', previousFindings: [], newFindings: [newBlocker()], summary: 'blocker' };
const resolveF001 = {
  verdict: 'approved',
  previousFindings: [{ id: 'F001', status: 'resolved', effectiveSeverity: null, explanation: 'behavior added' }],
  newFindings: [],
  summary: 'cleared'
};
const authorResolution = (ids) => ids.map((findingId) => ({
  findingId, action: 'accepted', changedSections: ['Implementation'], explanation: 'addressed'
}));

async function runtime2(repoRoot, author, r1, r2) {
  return {
    repoRoot,
    taskId: 'workflow',
    schemas: await loadSchemas(toolRoot),
    templates: await loadPromptTemplates(toolRoot),
    providers: { author, reviewers: [r1, r2] },
    agentsMd: '# Test instructions'
  };
}

const taskDirOf = (repoRoot) => path.join(repoRoot, '.plan-forge', 'workflow');
const reviewPath = (repoRoot, round) => path.join(taskDirOf(repoRoot), 'rounds', round, 'review.json');
const capturePath = (repoRoot, round, slot) => path.join(taskDirOf(repoRoot), 'rounds', round, 'reviews', `${slot}.json`);

test('barrier: the author runs once per round, after both captures and the merge (AC5, AC6, test 13/20)', async (t) => {
  const repoRoot = await tempRepo();
  t.after(() => fsp.rm(repoRoot, { recursive: true, force: true }));
  await initTask(repoRoot, 'workflow', { reviewers: TWO_SLOTS });
  const author = fakeProvider('claude', [
    { planMarkdown: plan('Round 1'), resolutions: [] },
    async (calls, request) => {
      // Test 13's core assertion, made at the moment the author is invoked:
      // both captures and the merged review are already committed.
      await fsp.access(capturePath(repoRoot, '001', 'R1'));
      await fsp.access(capturePath(repoRoot, '001', 'R2'));
      await fsp.access(reviewPath(repoRoot, '001'));
      return { planMarkdown: plan('Round 2'), resolutions: authorResolution(['F001', 'F002']) };
    }
  ]);
  const disposeBoth = (verdict) => ({
    verdict,
    previousFindings: [
      { id: 'F001', status: 'resolved', effectiveSeverity: null, explanation: 'fixed' },
      { id: 'F002', status: 'resolved', effectiveSeverity: null, explanation: 'fixed' }
    ],
    newFindings: [],
    summary: 'both cleared'
  });
  const r1 = fakeProvider('codex', [
    { ...blockerReview, newFindings: [newBlocker('found by R1')] },
    disposeBoth('approved')
  ], { model: 'gpt-a' });
  const r2 = fakeProvider('codex', [
    { ...blockerReview, newFindings: [newBlocker('found by R2')] },
    disposeBoth('approved')
  ], { model: 'gpt-b' });

  const result = await runWorkflow(await runtime2(repoRoot, author, r1, r2));
  assert.equal(result.status, 'approved');
  assert.equal(author.calls, 2);

  const round1 = JSON.parse(await fsp.readFile(reviewPath(repoRoot, '001'), 'utf8'));
  assert.equal(round1.meta.schemaVersion, 2);
  assert.equal(round1.review.verdict, 'changes_requested');
  // The union, attributed: one finding per slot, distinct ids, distinct models
  // in the round's own manifest (two slots sharing one provider — test 20).
  assert.deepEqual(
    round1.review.newFindings.map((item) => [item.id, item.raisedBy, item.problem]),
    [['F001', 'R1', 'found by R1'], ['F002', 'R2', 'found by R2']]
  );
  assert.deepEqual(round1.meta.reviewers.map((item) => [item.slot, item.provider, item.model]),
    [['R1', 'codex', 'gpt-a'], ['R2', 'codex', 'gpt-b']]);

  // Arbitration recorded on every disposition of round 2.
  const round2 = JSON.parse(await fsp.readFile(reviewPath(repoRoot, '002'), 'utf8'));
  for (const entry of round2.review.previousFindings) {
    assert.equal(entry.arbitration.dispositions.length, 2);
  }
});

test('prompt independence: equal fingerprints, no raisedBy in any reviewer prompt (Q3, test 14/15)', async (t) => {
  const repoRoot = await tempRepo();
  t.after(() => fsp.rm(repoRoot, { recursive: true, force: true }));
  await initTask(repoRoot, 'workflow', { reviewers: TWO_SLOTS });
  const prompts = { author: [], r1: [], r2: [] };
  const record = (list, data) => (calls, request) => {
    list.push(request.prompt);
    return data;
  };
  const author = fakeProvider('claude', [
    record(prompts.author, { planMarkdown: plan('Round 1'), resolutions: [] }),
    record(prompts.author, { planMarkdown: plan('Round 2'), resolutions: authorResolution(['F001']) })
  ]);
  const r1 = fakeProvider('codex', [record(prompts.r1, blockerReview), record(prompts.r1, resolveF001)], { model: 'gpt-a' });
  const r2 = fakeProvider('codex', [record(prompts.r2, approveEmpty), record(prompts.r2, resolveF001)], { model: 'gpt-b' });

  const result = await runWorkflow(await runtime2(repoRoot, author, r1, r2));
  assert.equal(result.status, 'approved');

  // Test 14 — one prompt per round, byte-identical across slots, and the
  // merged review records exactly that fingerprint.
  for (const round of [0, 1]) {
    assert.equal(prompts.r1[round], prompts.r2[round]);
  }
  for (const [round, file] of [[0, '001'], [1, '002']]) {
    const merged = JSON.parse(await fsp.readFile(reviewPath(repoRoot, file), 'utf8'));
    assert.equal(merged.meta.promptSha256, sha256(prompts.r1[round]));
    for (const capture of ['R1', 'R2']) {
      const wrapper = JSON.parse(await fsp.readFile(capturePath(repoRoot, file, capture), 'utf8'));
      assert.equal(wrapper.meta.promptSha256, merged.meta.promptSha256);
    }
  }

  const blockOf = (prompt, name) => {
    const match = prompt.match(new RegExp(`===== BEGIN ${name} =====\\n([\\s\\S]*?)\\n===== END ${name} =====`));
    return match ? JSON.parse(match[1]) : null;
  };
  // Test 14 — the reviewer's finding view carries no attribution.
  const reviewerFindings = blockOf(prompts.r1[1], 'ACTIVE FINDINGS TO DISPOSITION');
  assert.equal(reviewerFindings.length, 1);
  assert.equal('raisedBy' in reviewerFindings[0], false);
  // Test 15 — the author's view carries the slot id and nothing about the
  // provider or model behind it.
  const authorFindings = blockOf(prompts.author[1], 'ACTIVE FINDINGS');
  assert.equal(authorFindings[0].raisedBy, 'R1');
  assert.equal('provider' in authorFindings[0], false);
  assert.equal('model' in authorFindings[0], false);
  assert.doesNotMatch(JSON.stringify(authorFindings), /gpt-a|gpt-b|codex/);
});

test('partial failure: resume re-runs only the failed slot (AC8, test 16)', async (t) => {
  const repoRoot = await tempRepo();
  t.after(() => fsp.rm(repoRoot, { recursive: true, force: true }));
  await initTask(repoRoot, 'workflow', { reviewers: TWO_SLOTS });
  const author = fakeProvider('claude', [{ planMarkdown: plan('Round 1'), resolutions: [] }]);
  const r1 = fakeProvider('codex', [approveEmpty], { model: 'gpt-a' });
  const r2 = fakeProvider('codex', [() => { throw new ProviderError('reviewer down'); }, approveEmpty], { model: 'gpt-b' });
  const args = await runtime2(repoRoot, author, r1, r2);

  await assert.rejects(() => runWorkflow(args), /reviewer down/);
  const r1Capture = await fsp.readFile(capturePath(repoRoot, '001', 'R1'), 'utf8');
  await assert.rejects(() => fsp.access(reviewPath(repoRoot, '001')), /ENOENT/);
  const status = await inspectTask({ repoRoot, taskId: 'workflow', schemas: args.schemas, templates: args.templates, agentsMd: args.agentsMd });
  assert.equal(status.status, 'failed');
  assert.deepEqual(status.pendingReviewerSlots, ['R2']);

  const resumed = await runWorkflow(args);
  assert.equal(resumed.status, 'approved');
  assert.equal(r1.calls, 1);
  assert.equal(r2.calls, 2);
  assert.equal(author.calls, 1);
  // The healthy slot's capture is byte-unchanged across the resume.
  assert.equal(await fsp.readFile(capturePath(repoRoot, '001', 'R1'), 'utf8'), r1Capture);
});

test('a committed round survives a later override untouched (AC8, test 17)', async (t) => {
  const repoRoot = await tempRepo();
  t.after(() => fsp.rm(repoRoot, { recursive: true, force: true }));
  await initTask(repoRoot, 'workflow', { reviewers: TWO_SLOTS, maxRounds: 1 });
  const author = fakeProvider('claude', [
    { planMarkdown: plan('Round 1'), resolutions: [] },
    { planMarkdown: plan('Round 2'), resolutions: [] }
  ]);
  const r1 = fakeProvider('codex', [blockerReview, approveEmpty], { model: 'gpt-a' });
  const r2 = fakeProvider('codex', [approveEmpty, approveEmpty], { model: 'gpt-b' });
  const args = await runtime2(repoRoot, author, r1, r2);

  assert.equal((await runWorkflow(args)).status, 'needs_human');
  const round1Before = await fsp.readFile(reviewPath(repoRoot, '001'), 'utf8');

  await applyOverride({
    repoRoot, taskId: 'workflow', schemas: args.schemas,
    findingId: 'F001', disposition: 'withdrawn', severity: null, reason: 'human accepted counter-evidence'
  });
  assert.equal((await runWorkflow(args)).status, 'approved');

  const round1After = await fsp.readFile(reviewPath(repoRoot, '001'), 'utf8');
  assert.equal(round1After, round1Before);
  assert.equal(JSON.parse(round1After).review.verdict, 'changes_requested');
});

test('per-slot failure budgets latch independently (AC8, test 18)', async (t) => {
  const repoRoot = await tempRepo();
  t.after(() => fsp.rm(repoRoot, { recursive: true, force: true }));
  await initTask(repoRoot, 'workflow', { reviewers: TWO_SLOTS });
  const fail = () => { throw new ProviderError('permanent failure'); };
  const author = fakeProvider('claude', [{ planMarkdown: plan('Round 1'), resolutions: [] }]);
  const r1 = fakeProvider('codex', [approveEmpty], { model: 'gpt-a' });
  const r2 = fakeProvider('codex', [fail, fail], { model: 'gpt-b' });
  const args = await runtime2(repoRoot, author, r1, r2);

  await assert.rejects(() => runWorkflow(args), /permanent failure/);
  const second = await runWorkflow(args);
  assert.equal(second.status, 'needs_human');
  // R1's healthy capture kept it out of the second fan-out entirely.
  assert.equal(r1.calls, 1);
  assert.equal(r2.calls, 2);
  // A third run reports the latch without invoking anyone.
  const third = await runWorkflow(args);
  assert.equal(third.status, 'needs_human');
  assert.equal(third.errorClass, 'provider_failure_limit');
  assert.equal(r2.calls, 2);

  // Every failure record names R2; R1's budget is untouched.
  const failuresDir = path.join(taskDirOf(repoRoot), 'failures');
  const records = await Promise.all((await fsp.readdir(failuresDir)).map(async (name) =>
    JSON.parse(await fsp.readFile(path.join(failuresDir, name), 'utf8'))));
  assert.deepEqual(records.map((entry) => entry.slot), ['R2', 'R2']);
});

test('a legacy single-reviewer task resumes into the new layout (AC1, test 19)', async (t) => {
  const repoRoot = await tempRepo();
  t.after(() => fsp.rm(repoRoot, { recursive: true, force: true }));
  const requirement = '# Requirement\nBuild the workflow.\n';
  const roundDir = path.join(taskDirOf(repoRoot), 'rounds', '001');
  await fsp.mkdir(roundDir, { recursive: true });
  const legacyPlan = plan('Legacy round');
  // Hand-written, today-format artifacts: singular reviewer keys, a v1
  // review.json, an author output with no coversFindingIds anywhere.
  await fsp.writeFile(path.join(taskDirOf(repoRoot), 'task.json'), JSON.stringify({
    schemaVersion: 1, taskId: 'workflow',
    requirementMarkdown: requirement, requirementSha256: sha256(requirement),
    author: 'claude', reviewer: 'codex', authorModel: null, reviewerModel: null,
    authorEffort: 'xhigh', reviewerEffort: 'high', publishDir: 'docs/plans',
    maxRounds: 6, maxProviderFailures: 2, authorTimeoutMs: 5000, reviewerTimeoutMs: 5000,
    claudeAuthorMaxBudgetUsd: null, claudeReviewerMaxBudgetUsd: null,
    createdAt: '2026-01-01T00:00:00.000Z'
  }, null, 2));
  await fsp.writeFile(path.join(taskDirOf(repoRoot), 'overrides.json'), JSON.stringify({ schemaVersion: 1, entries: [] }));
  const authorMeta = {
    schemaVersion: 1, role: 'author', round: 1, provider: 'claude', model: null, cliVersion: 'test',
    promptSha256: sha256('legacy author prompt'), effort: 'xhigh',
    startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:01:00.000Z',
    usage: null, costUsd: null, sessionId: null, gitHead: null, gitDirty: null
  };
  await fsp.writeFile(path.join(roundDir, 'author-output.json'), JSON.stringify({
    meta: authorMeta,
    output: { planMarkdown: legacyPlan, resolutions: [] }
  }, null, 2));
  await fsp.writeFile(path.join(roundDir, 'review.json'), JSON.stringify({
    meta: {
      ...authorMeta, role: 'reviewer', promptSha256: sha256('legacy reviewer prompt'),
      planSha256: sha256(legacyPlan)
    },
    review: {
      verdict: 'changes_requested', previousFindings: [],
      newFindings: [{ ...newBlocker('legacy blocker'), id: 'F001' }],
      summary: 'one blocker'
    }
  }, null, 2));
  const legacyReviewBytes = await fsp.readFile(path.join(roundDir, 'review.json'), 'utf8');

  const prompts = { author: [] };
  const author = fakeProvider('claude', [
    (calls, request) => {
      prompts.author.push(request.prompt);
      return { planMarkdown: plan('Round 2'), resolutions: authorResolution(['F001']) };
    }
  ]);
  const reviewer = fakeProvider('codex', [resolveF001]);
  const args = {
    repoRoot, taskId: 'workflow',
    schemas: await loadSchemas(toolRoot), templates: await loadPromptTemplates(toolRoot),
    providers: { author, reviewers: [reviewer] }, agentsMd: '# Test instructions'
  };
  const result = await runWorkflow(args);
  assert.equal(result.status, 'approved');

  // Round 1 took the v1 branch and was not rewritten.
  assert.equal(await fsp.readFile(path.join(roundDir, 'review.json'), 'utf8'), legacyReviewBytes);
  // Round 2 was written in the new layout at schemaVersion 2.
  const round2 = JSON.parse(await fsp.readFile(reviewPath(repoRoot, '002'), 'utf8'));
  assert.equal(round2.meta.schemaVersion, 2);
  await fsp.access(capturePath(repoRoot, '002', 'R1'));
  // §6's default: the v1 finding renders with raisedBy R1 in the author prompt.
  const match = prompts.author[0].match(/===== BEGIN ACTIVE FINDINGS =====\n([\s\S]*?)\n===== END ACTIVE FINDINGS =====/);
  assert.equal(JSON.parse(match[1])[0].raisedBy, 'R1');
  // The approval validates over the mixed v1/v2 history.
  const approval = JSON.parse(await fsp.readFile(path.join(taskDirOf(repoRoot), 'approval.json'), 'utf8'));
  assert.equal(approval.round, 2);
});

test('an override between two slots of one round re-fans-out the whole round (§7.3, tests 23/24)', async (t) => {
  const repoRoot = await tempRepo();
  t.after(() => fsp.rm(repoRoot, { recursive: true, force: true }));
  await initTask(repoRoot, 'workflow', { reviewers: TWO_SLOTS });
  const author = fakeProvider('claude', [
    { planMarkdown: plan('Round 1'), resolutions: [] },
    { planMarkdown: plan('Round 2'), resolutions: authorResolution(['F001']) }
  ]);
  // Round 2: R1 commits its capture, R2 fails — then a human withdraws F001.
  const r1 = fakeProvider('codex', [blockerReview, resolveF001, approveEmpty], { model: 'gpt-a' });
  const r2 = fakeProvider('codex', [approveEmpty, () => { throw new ProviderError('flaky'); }, approveEmpty], { model: 'gpt-b' });
  const args = await runtime2(repoRoot, author, r1, r2);

  await assert.rejects(() => runWorkflow(args), /flaky/);
  const staleCapture = JSON.parse(await fsp.readFile(capturePath(repoRoot, '002', 'R1'), 'utf8'));
  const round1Bytes = await fsp.readFile(reviewPath(repoRoot, '001'), 'utf8');

  await applyOverride({
    repoRoot, taskId: 'workflow', schemas: args.schemas,
    findingId: 'F001', disposition: 'withdrawn', severity: null, reason: 'human ruling mid-round'
  });
  const result = await runWorkflow(args);
  assert.equal(result.status, 'approved');

  // Both slots ran again: the override changed the round's question, so R1's
  // committed answer was superseded, not preserved.
  assert.equal(r1.calls, 3);
  assert.equal(r2.calls, 3);
  const round2 = JSON.parse(await fsp.readFile(reviewPath(repoRoot, '002'), 'utf8'));
  const freshCapture = JSON.parse(await fsp.readFile(capturePath(repoRoot, '002', 'R1'), 'utf8'));
  assert.notEqual(freshCapture.meta.promptSha256, staleCapture.meta.promptSha256);
  assert.equal(freshCapture.meta.promptSha256, round2.meta.promptSha256);
  // The withdrawn finding is no longer part of the round's question.
  assert.deepEqual(round2.review.previousFindings, []);
  // The committed round 1 is untouched by any of it.
  assert.equal(await fsp.readFile(reviewPath(repoRoot, '001'), 'utf8'), round1Bytes);
});

test('merged captures are verified on every load (AC5, test 25)', async (t) => {
  const repoRoot = await tempRepo();
  t.after(() => fsp.rm(repoRoot, { recursive: true, force: true }));
  await initTask(repoRoot, 'workflow', { reviewers: TWO_SLOTS });
  const author = fakeProvider('claude', [{ planMarkdown: plan('Round 1'), resolutions: [] }]);
  const r1 = fakeProvider('codex', [approveEmpty], { model: 'gpt-a' });
  const r2 = fakeProvider('codex', [approveEmpty], { model: 'gpt-b' });
  const args = await runtime2(repoRoot, author, r1, r2);
  assert.equal((await runWorkflow(args)).status, 'approved');

  const inspect = () => inspectTask({ repoRoot, taskId: 'workflow', schemas: args.schemas });
  const r2File = capturePath(repoRoot, '001', 'R2');
  const original = await fsp.readFile(r2File, 'utf8');

  // (a) a deleted capture is a named error
  await fsp.rm(r2File);
  await assert.rejects(inspect, /missing the committed review for slot R2/);
  // (b) a flipped byte is a recorded-sha mismatch
  await fsp.writeFile(r2File, original.replace('"clean"', '"CLEAN"'));
  await assert.rejects(inspect, /does not match the sha256 recorded when the round merged/);
  await fsp.writeFile(r2File, original);
  // (c) a capture for a slot outside the roster is unknown
  await fsp.writeFile(capturePath(repoRoot, '001', 'R3'), original);
  await assert.rejects(inspect, /unknown reviewer slot R3/);
  await fsp.rm(capturePath(repoRoot, '001', 'R3'));
  // (d) the untouched round loads clean and is not rewritten
  const status = await inspect();
  assert.equal(status.status, 'approved');
  assert.equal(await fsp.readFile(r2File, 'utf8'), original);
});

test('a pre-merge capture must agree with its configured slot (§7.1, test 32)', async (t) => {
  const repoRoot = await tempRepo();
  t.after(() => fsp.rm(repoRoot, { recursive: true, force: true }));
  await initTask(repoRoot, 'workflow', { reviewers: TWO_SLOTS });
  const author = fakeProvider('claude', [{ planMarkdown: plan('Round 1'), resolutions: [] }]);
  const r1 = fakeProvider('codex', [approveEmpty, approveEmpty], { model: 'gpt-a' });
  const r2 = fakeProvider('codex', [() => { throw new ProviderError('down'); }, approveEmpty], { model: 'gpt-b' });
  const args = await runtime2(repoRoot, author, r1, r2);
  await assert.rejects(() => runWorkflow(args), /down/);

  const r1File = capturePath(repoRoot, '001', 'R1');
  const original = JSON.parse(await fsp.readFile(r1File, 'utf8'));
  const inspect = () => inspectTask({ repoRoot, taskId: 'workflow', schemas: args.schemas });

  // (a) provider disagreement is tampering, not a supersession
  await fsp.writeFile(r1File, JSON.stringify({ ...original, meta: { ...original.meta, provider: 'claude' } }));
  await assert.rejects(inspect, /was produced by claude, but the slot is configured for codex/);
  // (b) a pinned slot rejects a capture recording another model
  await fsp.writeFile(r1File, JSON.stringify({ ...original, meta: { ...original.meta, model: 'gpt-5-mini' } }));
  await assert.rejects(inspect, /records model gpt-5-mini, but the slot is pinned to gpt-a/);
  // (c) deleting the offending capture is a complete repair: the slot re-runs
  await fsp.rm(r1File);
  const result = await runWorkflow(args);
  assert.equal(result.status, 'approved');
  assert.equal(r1.calls, 2);
});

test('a merged round cannot masquerade as legacy or shed provenance (§2.1, test 33)', async (t) => {
  const repoRoot = await tempRepo();
  t.after(() => fsp.rm(repoRoot, { recursive: true, force: true }));
  await initTask(repoRoot, 'workflow', { reviewers: TWO_SLOTS });
  const author = fakeProvider('claude', [
    { planMarkdown: plan('Round 1'), resolutions: [] },
    { planMarkdown: plan('Round 2'), resolutions: authorResolution(['F001']) }
  ]);
  const r1 = fakeProvider('codex', [blockerReview, resolveF001], { model: 'gpt-a' });
  const r2 = fakeProvider('codex', [approveEmpty, resolveF001], { model: 'gpt-b' });
  const args = await runtime2(repoRoot, author, r1, r2);
  assert.equal((await runWorkflow(args)).status, 'approved');

  const file = reviewPath(repoRoot, '002');
  const originalBytes = await fsp.readFile(file, 'utf8');
  const original = JSON.parse(originalBytes);
  const inspect = () => inspectTask({ repoRoot, taskId: 'workflow', schemas: args.schemas });
  const mutate = async (value, pattern) => {
    await fsp.writeFile(file, JSON.stringify(value, null, 2));
    await assert.rejects(inspect, pattern);
    await fsp.writeFile(file, originalBytes);
  };
  const withMeta = (meta) => ({ ...original, meta });
  const { reviewers, ...metaSansReviewers } = original.meta;

  // (a) v2 without its manifest: loud schema failure, never a silent legacy read
  await mutate(withMeta(metaSansReviewers), /reviewers/);
  // (b) full masquerade: the v1 branch rejects raisedBy as an additional property
  await mutate({ ...original, meta: { ...metaSansReviewers, schemaVersion: 1 } }, /schema validation failed/);
  // (c) v1 claiming merge provenance is a contradiction
  await mutate(withMeta({ ...original.meta, schemaVersion: 1 }), /declares schemaVersion 1 but carries merge provenance/);
  // (d) absence is an error, never a fallback
  const { schemaVersion, ...metaSansVersion } = original.meta;
  await mutate(withMeta(metaSansVersion), /unsupported schemaVersion undefined/);
  // (e) unknown versions are refused
  await mutate(withMeta({ ...original.meta, schemaVersion: 3 }), /unsupported schemaVersion 3/);
  // (f) provenance is required per finding: raisedBy on a new finding (round 1
  // holds the new findings), arbitration on a disposition (round 2 holds those)
  const round1File = reviewPath(repoRoot, '001');
  const round1Bytes = await fsp.readFile(round1File, 'utf8');
  const round1 = JSON.parse(round1Bytes);
  await fsp.writeFile(round1File, JSON.stringify({
    ...round1,
    review: { ...round1.review, newFindings: round1.review.newFindings.map(({ raisedBy, ...rest }) => rest) }
  }, null, 2));
  await assert.rejects(inspect, /schema validation failed/);
  await fsp.writeFile(round1File, round1Bytes);
  await mutate({
    ...original,
    review: {
      ...original.review,
      previousFindings: original.review.previousFindings.map(({ arbitration, ...rest }) => rest)
    }
  }, /schema validation failed/);
  // (g) duplicate slots in the manifest
  await mutate(withMeta({ ...original.meta, reviewers: [reviewers[0], reviewers[0]] }), /lists reviewer slot R1 twice/);
  // (h) the truncated jury: manifest and captures agree with each other but not
  // with the frozen roster
  const r2File = capturePath(repoRoot, '002', 'R2');
  const r2Bytes = await fsp.readFile(r2File, 'utf8');
  await fsp.rm(r2File);
  await mutate(withMeta({ ...original.meta, reviewers: [reviewers[0]] }), /merged under slots R1 but the task roster is R1, R2/);
  await fsp.writeFile(r2File, r2Bytes);

  // The untouched task still loads.
  assert.equal((await inspect()).status, 'approved');
});

test('a mismatched reviewer runtime spends nothing (§3.1, test 31)', async (t) => {
  const repoRoot = await tempRepo();
  t.after(() => fsp.rm(repoRoot, { recursive: true, force: true }));
  await initTask(repoRoot, 'workflow', {
    reviewers: [
      { provider: 'codex', model: 'gpt-a', effort: null, claudeMaxBudgetUsd: null },
      { provider: 'claude', model: 'opus', effort: null, claudeMaxBudgetUsd: null }
    ]
  });
  const author = fakeProvider('claude', [{ planMarkdown: plan('Round 1'), resolutions: [] }]);
  const claudeFake = fakeProvider('claude', [approveEmpty], { model: 'opus' });
  const codexFake = fakeProvider('codex', [approveEmpty], { model: 'gpt-a' });
  const base = {
    repoRoot, taskId: 'workflow',
    schemas: await loadSchemas(toolRoot), templates: await loadPromptTemplates(toolRoot),
    agentsMd: '# Test instructions'
  };

  // Swapped adapters: rejected before any provider call, the author's included.
  await assert.rejects(
    () => runWorkflow({ ...base, providers: { author, reviewers: [claudeFake, codexFake] } }),
    /reviewer slot R1 is configured for codex but the runtime supplied a claude adapter/
  );
  // A short array is a named length error, not an undefined-index crash.
  await assert.rejects(
    () => runWorkflow({ ...base, providers: { author, reviewers: [codexFake] } }),
    /1 reviewer adapters were supplied for a 2-slot roster/
  );
  assert.equal(author.calls, 0);
  assert.equal(claudeFake.calls, 0);
  assert.equal(codexFake.calls, 0);
  await assert.rejects(() => fsp.access(path.join(taskDirOf(repoRoot), 'rounds', '001')), /ENOENT/);
});

test('a multi-reviewer stall publishes a valid header and a stable brief (test 27)', async (t) => {
  const repoRoot = await tempRepo();
  t.after(() => fsp.rm(repoRoot, { recursive: true, force: true }));
  await initTask(repoRoot, 'workflow', { reviewers: TWO_SLOTS, maxRounds: 1 });
  const author = fakeProvider('claude', [{ planMarkdown: plan('Stalled'), resolutions: [] }]);
  const r1 = fakeProvider('codex', [blockerReview], { model: 'gpt-a' });
  const r2 = fakeProvider('codex', [approveEmpty], { model: 'gpt-b' });
  const args = await runtime2(repoRoot, author, r1, r2);
  assert.equal((await runWorkflow(args)).status, 'needs_human');

  const pendingPath = path.join(repoRoot, 'docs', 'plans', 'needs_human', 'workflow.md');
  const pending = await fsp.readFile(pendingPath, 'utf8');
  assert.match(pending, /reviewer=codex,codex status=needs_human /);
  // stoppedAt is the merge instant — present, ISO-parseable, and stable.
  const stoppedAt = /stoppedAt=(\S+)/.exec(pending)[1];
  const merged = JSON.parse(await fsp.readFile(reviewPath(repoRoot, '001'), 'utf8'));
  assert.equal(stoppedAt, merged.meta.completedAt);
  assert.ok(Number.isFinite(Date.parse(stoppedAt)));
  // The brief names the raising slot.
  assert.match(pending, /## F001 — blocker · Implementation \(raised by R1\)/);

  // Re-running the stalled task does not churn the published file.
  assert.equal((await runWorkflow(args)).status, 'needs_human');
  assert.equal(await fsp.readFile(pendingPath, 'utf8'), pending);
});

test('roster creation pins models at N>1 and rejects unresolvable slots (§1.2, tests 21/26)', async (t) => {
  const repoRoot = await tempRepo();
  t.after(() => fsp.rm(repoRoot, { recursive: true, force: true }));
  const { initializeTask, resolveModel } = await import('../lib/workflow.mjs');
  const base = { maxRounds: 6, maxProviderFailures: 2, authorTimeoutMs: 5000, reviewerTimeoutMs: 5000 };
  const codexSlot = (model) => ({ provider: 'codex', model, effort: null, claudeMaxBudgetUsd: null });

  // Test 21 — an unresolvable slot throws at creation, an empty roster too.
  delete process.env.PLAN_FORGE_CODEX_MODEL;
  await assert.rejects(
    () => initTask(repoRoot, 'multi-unpinned', { reviewers: [codexSlot('gpt-a'), codexSlot(null)] }),
    /reviewer slot R2 \(codex\) has no model; a multi-reviewer roster must pin every slot/
  );
  await assert.rejects(
    () => initializeTask({
      repoRoot, taskId: 'empty-roster', requirementText: 'x',
      options: { author: 'claude', reviewers: [], ...base }
    }),
    /a task needs at least one reviewer slot/
  );

  // Test 26(c) — an env-provided model is a valid pin, frozen at creation.
  process.env.PLAN_FORGE_CODEX_MODEL = 'gpt-5.6';
  t.after(() => delete process.env.PLAN_FORGE_CODEX_MODEL);
  await initTask(repoRoot, 'multi-env', { reviewers: [codexSlot(null), codexSlot(null)] });
  const task = JSON.parse(await fsp.readFile(path.join(repoRoot, '.plan-forge', 'multi-env', 'task.json'), 'utf8'));
  assert.deepEqual(task.reviewers.map((slot) => slot.model), ['gpt-5.6', 'gpt-5.6']);
  // Changing the env afterward changes nothing for a pinned slot...
  assert.equal(resolveModel('codex', task.reviewers[0].model, { PLAN_FORGE_CODEX_MODEL: 'other' }), 'gpt-5.6');

  // Test 26(a)/(b) — N=1 stays late-bound: null stored, env read at run time,
  // an explicit flag still wins.
  await initTask(repoRoot, 'single-env', { reviewers: [codexSlot(null)] });
  const single = JSON.parse(await fsp.readFile(path.join(repoRoot, '.plan-forge', 'single-env', 'task.json'), 'utf8'));
  assert.equal(single.reviewers[0].model, null);
  assert.equal(resolveModel('codex', single.reviewers[0].model, { PLAN_FORGE_CODEX_MODEL: 'model-b' }), 'model-b');
  assert.equal(resolveModel('codex', 'model-a', { PLAN_FORGE_CODEX_MODEL: 'model-b' }), 'model-a');
});

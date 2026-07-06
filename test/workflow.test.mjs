import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { ProviderError } from '../lib/process.mjs';
import { loadPromptTemplates } from '../lib/prompts.mjs';
import { loadSchemas } from '../lib/schema.mjs';
import { applyOverride, clearFailures, inspectTask, resolveEffort, runWorkflow, updateTaskSettings } from '../lib/workflow.mjs';
import { fakeProvider, initTask, plan, tempRepo, toolRoot } from './helpers.mjs';

function newBlocker() {
  return {
    id: null, relatedToFindingId: null, noveltyRationale: 'new correctness issue', severity: 'blocker',
    category: 'correctness', planSection: 'Implementation', problem: 'the plan is incomplete',
    evidence: ['src/a.js'], requiredChange: 'add the missing behavior'
  };
}

function resolution() {
  return [{ findingId: 'F001', action: 'accepted', changedSections: ['Implementation'], explanation: 'addressed' }];
}

async function runtime(repoRoot, author, reviewer) {
  return {
    repoRoot,
    taskId: 'workflow',
    schemas: await loadSchemas(toolRoot),
    templates: await loadPromptTemplates(toolRoot),
    providers: { author, reviewer },
    agentsMd: '# Test instructions'
  };
}

test('workflow gives two revision attempts before needs_human', async (t) => {
  const repoRoot = await tempRepo();
  t.after(() => fsp.rm(repoRoot, { recursive: true, force: true }));
  await initTask(repoRoot, 'workflow');
  const author = fakeProvider('claude', [
    { planMarkdown: plan('Round 1'), resolutions: [] },
    { planMarkdown: plan('Round 2'), resolutions: resolution() },
    { planMarkdown: plan('Round 3'), resolutions: resolution() }
  ]);
  const stillOpen = { id: 'F001', status: 'still_open', effectiveSeverity: null, explanation: 'still broken' };
  const reviewer = fakeProvider('codex', [
    { verdict: 'changes_requested', previousFindings: [], newFindings: [newBlocker()], summary: 'blocker' },
    { verdict: 'changes_requested', previousFindings: [stillOpen], newFindings: [], summary: 'still open once' },
    { verdict: 'changes_requested', previousFindings: [stillOpen], newFindings: [], summary: 'still open twice' }
  ]);
  const args = await runtime(repoRoot, author, reviewer);
  const result = await runWorkflow(args);
  assert.equal(result.status, 'needs_human');
  assert.equal(result.round, 3);
  assert.equal(author.calls, 3);
  assert.equal(reviewer.calls, 3);

  const status = await inspectTask({ repoRoot, taskId: 'workflow', schemas: args.schemas });
  assert.equal(status.status, 'needs_human');
  assert.equal(status.blockingFindings.length, 1);
  assert.equal(status.blockingFindings[0].id, 'F001');
  assert.equal(status.blockingFindings[0].problem, 'the plan is incomplete');
  assert.equal(status.blockingFindings[0].requiredChange, 'add the missing behavior');
  assert.equal(status.blockingFindings[0].lastExplanation, 'still broken');
  assert.equal(status.blockingFindings[0].criticalReviewStreak, 2);
});

test('approval and all derived projections recover without provider calls', async (t) => {
  const repoRoot = await tempRepo();
  t.after(() => fsp.rm(repoRoot, { recursive: true, force: true }));
  await initTask(repoRoot, 'workflow');
  const author = fakeProvider('claude', [{ planMarkdown: plan('Approved'), resolutions: [] }]);
  const reviewer = fakeProvider('codex', [{ verdict: 'approved', previousFindings: [], newFindings: [], summary: 'ok' }]);
  const args = await runtime(repoRoot, author, reviewer);
  const result = await runWorkflow(args);
  assert.equal(result.status, 'approved');

  const taskDir = path.join(repoRoot, '.plan-forge', 'workflow');
  const publishedPath = path.join(repoRoot, 'docs', 'plans', 'workflow.md');
  const published = await fsp.readFile(publishedPath, 'utf8');
  assert.match(published, /^<!-- plan-forge: task=workflow round=1 author=claude reviewer=codex /);
  assert.match(published, /## Appendix: Frozen Requirement/);
  assert.match(published, /Build the workflow/);
  assert.match(published, /# Approved/);

  await fsp.rm(path.join(taskDir, 'state.json'));
  await fsp.rm(path.join(taskDir, 'final.md'));
  await fsp.rm(publishedPath);
  await fsp.rm(path.join(taskDir, 'rounds', '001', 'plan.md'));
  await fsp.rm(path.join(taskDir, 'rounds', '001', 'resolution.json'));
  await fsp.rm(path.join(taskDir, 'rounds', '001', 'manifest.json'));
  const recovered = await runWorkflow(args);
  assert.equal(recovered.status, 'approved');
  assert.equal(author.calls, 1);
  assert.equal(reviewer.calls, 1);
  assert.match(await fsp.readFile(path.join(taskDir, 'final.md'), 'utf8'), /# Approved/);
  assert.match(await fsp.readFile(path.join(taskDir, 'rounds', '001', 'plan.md'), 'utf8'), /# Approved/);
  assert.equal(await fsp.readFile(publishedPath, 'utf8'), published);
  const manifest = JSON.parse(await fsp.readFile(path.join(taskDir, 'rounds', '001', 'manifest.json'), 'utf8'));
  assert.equal(manifest.round, 1);
});

test('failure artifacts rebuild provider failure limit after state loss', async (t) => {
  const repoRoot = await tempRepo();
  t.after(() => fsp.rm(repoRoot, { recursive: true, force: true }));
  await initTask(repoRoot, 'workflow');
  const fail = () => new ProviderError('permanent failure');
  const author = fakeProvider('claude', [fail(), fail()]);
  const reviewer = fakeProvider('codex', []);
  const args = await runtime(repoRoot, author, reviewer);
  await assert.rejects(() => runWorkflow(args), /permanent failure/);
  const statePath = path.join(repoRoot, '.plan-forge', 'workflow', 'state.json');
  await fsp.rm(statePath, { force: true });
  const second = await runWorkflow(args);
  assert.equal(second.status, 'needs_human');
  await fsp.rm(statePath, { force: true });
  const status = await inspectTask({ repoRoot, taskId: 'workflow', schemas: args.schemas });
  assert.equal(status.status, 'needs_human');
});

test('clearing provider failures unlatches needs_human and status reports the pending phase', async (t) => {
  const repoRoot = await tempRepo();
  t.after(() => fsp.rm(repoRoot, { recursive: true, force: true }));
  await initTask(repoRoot, 'workflow');
  const fail = () => new ProviderError('permanent failure');
  const author = fakeProvider('claude', [fail(), fail(), { planMarkdown: plan('Recovered'), resolutions: [] }]);
  const reviewer = fakeProvider('codex', [{ verdict: 'approved', previousFindings: [], newFindings: [], summary: 'ok' }]);
  const args = await runtime(repoRoot, author, reviewer);

  await assert.rejects(() => runWorkflow(args), /permanent failure/);
  const failedStatus = await inspectTask({ repoRoot, taskId: 'workflow', schemas: args.schemas });
  assert.equal(failedStatus.status, 'failed');
  assert.equal(failedStatus.phase, 'drafting');
  assert.equal(failedStatus.round, 1);

  assert.equal((await runWorkflow(args)).status, 'needs_human');
  assert.equal((await runWorkflow(args)).status, 'needs_human');
  assert.equal(author.calls, 2);

  await assert.rejects(
    () => clearFailures({ repoRoot, taskId: 'no-such-task', reason: 'x' }),
    /ENOENT/
  );
  await clearFailures({ repoRoot, taskId: 'workflow', reason: 'network restored' });
  const cleared = await runWorkflow(args);
  assert.equal(cleared.status, 'approved');
  assert.equal(author.calls, 3);
  await assert.rejects(
    () => clearFailures({ repoRoot, taskId: 'workflow', reason: 'again' }),
    /no provider failures to clear/
  );
});

test('status reports the pending review phase after the author commits', async (t) => {
  const repoRoot = await tempRepo();
  t.after(() => fsp.rm(repoRoot, { recursive: true, force: true }));
  await initTask(repoRoot, 'workflow');
  const author = fakeProvider('claude', [{ planMarkdown: plan('Pending review'), resolutions: [] }]);
  const reviewer = fakeProvider('codex', [() => { throw new ProviderError('reviewer down'); }]);
  const args = await runtime(repoRoot, author, reviewer);
  await assert.rejects(() => runWorkflow(args), /reviewer down/);
  const status = await inspectTask({ repoRoot, taskId: 'workflow', schemas: args.schemas });
  assert.equal(status.phase, 'reviewing');
  assert.equal(status.round, 1);
  assert.equal(status.status, 'failed');
});

test('custom publish dir is honored and traversal is rejected at init', async (t) => {
  const repoRoot = await tempRepo();
  t.after(() => fsp.rm(repoRoot, { recursive: true, force: true }));
  await assert.rejects(
    () => initTask(repoRoot, 'evil', { publishDir: '../outside' }),
    /path escapes allowed root/
  );
  await initTask(repoRoot, 'workflow', { publishDir: 'notes/approved' });
  const author = fakeProvider('claude', [{ planMarkdown: plan('Custom dir'), resolutions: [] }]);
  const reviewer = fakeProvider('codex', [{ verdict: 'approved', previousFindings: [], newFindings: [], summary: 'ok' }]);
  const result = await runWorkflow(await runtime(repoRoot, author, reviewer));
  assert.equal(result.status, 'approved');
  assert.match(await fsp.readFile(path.join(repoRoot, 'notes', 'approved', 'workflow.md'), 'utf8'), /# Custom dir/);
});

test('resume-time setting overrides persist into task.json', async (t) => {
  const repoRoot = await tempRepo();
  t.after(() => fsp.rm(repoRoot, { recursive: true, force: true }));
  await initTask(repoRoot, 'workflow');
  const before = JSON.parse(await fsp.readFile(path.join(repoRoot, '.plan-forge', 'workflow', 'task.json'), 'utf8'));
  assert.equal(before.authorEffort, 'xhigh');
  assert.equal(before.reviewerEffort, 'high');
  const updated = await updateTaskSettings({ repoRoot, taskId: 'workflow', reviewerTimeoutMs: 1800000, reviewerEffort: 'xhigh' });
  assert.equal(updated.reviewerTimeoutMs, 1800000);
  assert.equal(updated.reviewerEffort, 'xhigh');
  assert.equal(updated.authorTimeoutMs, before.authorTimeoutMs);
  assert.equal(updated.authorEffort, 'xhigh');
  assert.equal(updated.requirementSha256, before.requirementSha256);
  const persisted = JSON.parse(await fsp.readFile(path.join(repoRoot, '.plan-forge', 'workflow', 'task.json'), 'utf8'));
  assert.equal(persisted.reviewerTimeoutMs, 1800000);
  assert.equal(persisted.reviewerEffort, 'xhigh');
  await assert.rejects(
    () => updateTaskSettings({ repoRoot, taskId: 'workflow', reviewerEffort: 'max' }),
    /invalid effort "max" for codex/
  );
});

test('effort resolution applies per-provider defaults and enums', () => {
  assert.equal(resolveEffort('claude', null), 'xhigh');
  assert.equal(resolveEffort('codex', null), 'high');
  assert.equal(resolveEffort('claude', 'max'), 'max');
  assert.equal(resolveEffort('codex', 'none'), 'none');
  assert.throws(() => resolveEffort('claude', 'none'), /invalid effort "none" for claude/);
  assert.throws(() => resolveEffort('codex', 'max'), /invalid effort "max" for codex/);
  assert.throws(() => resolveEffort('gemini', 'high'), /unsupported provider/);
});

test('human override closes a blocker without rewriting review history', async (t) => {
  const repoRoot = await tempRepo();
  t.after(() => fsp.rm(repoRoot, { recursive: true, force: true }));
  await initTask(repoRoot, 'workflow', { maxRounds: 1 });
  const author = fakeProvider('claude', [{ planMarkdown: plan('Override'), resolutions: [] }]);
  const reviewer = fakeProvider('codex', [
    { verdict: 'changes_requested', previousFindings: [], newFindings: [newBlocker()], summary: 'blocker' }
  ]);
  const args = await runtime(repoRoot, author, reviewer);
  const blocked = await runWorkflow(args);
  assert.equal(blocked.status, 'needs_human');
  await applyOverride({
    repoRoot,
    taskId: 'workflow',
    schemas: args.schemas,
    findingId: 'F001',
    disposition: 'withdrawn',
    severity: null,
    reason: 'human accepted alternate evidence'
  });
  const approved = await runWorkflow(args);
  assert.equal(approved.status, 'approved');
  assert.equal(author.calls, 1);
  assert.equal(reviewer.calls, 1);
  const review = JSON.parse(await fsp.readFile(path.join(repoRoot, '.plan-forge', 'workflow', 'rounds', '001', 'review.json')));
  assert.equal(review.review.newFindings[0].id, 'F001');
});

test('inline requirement text freezes without a source file', async (t) => {
  const repoRoot = await tempRepo();
  t.after(() => fsp.rm(repoRoot, { recursive: true, force: true }));
  await initTask(repoRoot, 'workflow', { requirementText: '# Inline requirement\n\nShip the thing inline.' });
  const taskDir = path.join(repoRoot, '.plan-forge', 'workflow');
  const task = JSON.parse(await fsp.readFile(path.join(taskDir, 'task.json'), 'utf8'));
  assert.match(task.requirementMarkdown, /Ship the thing inline/);

  const author = fakeProvider('claude', [{ planMarkdown: plan('Inline'), resolutions: [] }]);
  const reviewer = fakeProvider('codex', [{ verdict: 'approved', previousFindings: [], newFindings: [], summary: 'ok' }]);
  const result = await runWorkflow(await runtime(repoRoot, author, reviewer));
  assert.equal(result.status, 'approved');
  const published = await fsp.readFile(path.join(repoRoot, 'docs', 'plans', 'workflow.md'), 'utf8');
  assert.match(published, /Ship the thing inline/);

  const { initializeTask } = await import('../lib/workflow.mjs');
  await assert.rejects(
    () => initializeTask({ repoRoot, taskId: 'both', requirementFile: 'x.md', requirementText: 'y', options: {} }),
    /exactly one of/
  );
  await assert.rejects(
    () => initializeTask({ repoRoot, taskId: 'neither', options: {} }),
    /exactly one of/
  );
});

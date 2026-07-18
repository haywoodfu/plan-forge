import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { reviewerRosterFromArgs } from '../lib/roster.mjs';
import { initTask, tempRepo } from './helpers.mjs';

// Mirrors cli.mjs parseArgs: values is last-wins, tokens keeps argv order.
function args(pairs) {
  const values = {};
  for (const [key, value] of pairs) values[key] = value;
  return { tokens: pairs, values };
}

const slot = (provider, model = null, effort = null, budget = null) =>
  ({ provider, model, effort, claudeMaxBudgetUsd: budget });

test('zero --reviewer defaults to one codex slot, order-independent binding (test 30)', () => {
  // The plain invocation — the case the roster rules must not drop.
  assert.deepEqual(
    reviewerRosterFromArgs({ author: 'claude', ...args([]) }),
    [slot('codex')]
  );
  // --reviewer-model binds with no --reviewer present, as cli.mjs:103 does today.
  assert.deepEqual(
    reviewerRosterFromArgs({ author: 'claude', ...args([['reviewer-model', 'gpt-5.6']]) }),
    [slot('codex', 'gpt-5.6')]
  );
  // Flag before the slot, one reviewer: order-independent.
  assert.deepEqual(
    reviewerRosterFromArgs({ author: 'claude', ...args([['reviewer-model', 'gpt-5.6'], ['reviewer', 'codex']]) }),
    [slot('codex', 'gpt-5.6')]
  );
});

test('two or more --reviewer bind positionally (test 30)', () => {
  // The model binds to R2 only; R1's stays null.
  assert.deepEqual(
    reviewerRosterFromArgs({
      author: 'claude',
      ...args([['reviewer', 'codex'], ['reviewer', 'claude'], ['reviewer-model', 'opus']]),
      values: { reviewer: 'claude', 'reviewer-model': 'opus', 'allow-same-provider': true }
    }),
    [slot('codex'), slot('claude', 'opus')]
  );
  // A slot-scoped flag before the first --reviewer is an error.
  assert.throws(
    () => reviewerRosterFromArgs({
      author: 'claude',
      ...args([['reviewer-model', 'o'], ['reviewer', 'codex'], ['reviewer', 'codex']])
    }),
    /--reviewer-model must follow the --reviewer it configures when several reviewers are given/
  );
  // Per-slot effort and budget bind to their preceding slot.
  assert.deepEqual(
    reviewerRosterFromArgs({
      author: 'claude',
      ...args([
        ['reviewer', 'codex'], ['reviewer-effort', 'xhigh'],
        ['reviewer', 'codex'], ['reviewer-model', 'gpt-5-mini'], ['claude-reviewer-max-budget-usd', '3']
      ])
    }),
    [slot('codex', null, 'xhigh'), slot('codex', 'gpt-5-mini', null, 3)]
  );
});

test('provider and same-provider guards keep today\'s exact messages (test 30)', () => {
  assert.throws(
    () => reviewerRosterFromArgs({ author: 'claude', ...args([['reviewer', 'gemini']]) }),
    /--author and --reviewer must be claude or codex/
  );
  // Author claude + one claude slot needs the flag...
  assert.throws(
    () => reviewerRosterFromArgs({ author: 'claude', ...args([['reviewer', 'claude']]) }),
    /author and reviewer must differ unless --allow-same-provider is set/
  );
  // ...and passes with it.
  assert.deepEqual(
    reviewerRosterFromArgs({
      author: 'claude',
      tokens: [['reviewer', 'claude']],
      values: { reviewer: 'claude', 'allow-same-provider': true }
    }),
    [slot('claude')]
  );
  // Two codex slots with a claude author need no flag: the guard is
  // author-vs-reviewer, and reviewer-reviewer sharing is deliberate.
  assert.deepEqual(
    reviewerRosterFromArgs({
      author: 'claude',
      ...args([['reviewer', 'codex'], ['reviewer', 'codex'], ['reviewer-model', 'gpt-5-mini']])
    }),
    [slot('codex'), slot('codex', 'gpt-5-mini')]
  );
});

test('the default roster reaches disk in roster form (test 30, end to end)', async (t) => {
  const repoRoot = await tempRepo();
  t.after(() => fsp.rm(repoRoot, { recursive: true, force: true }));
  await initTask(repoRoot, 'default-roster', {
    reviewers: reviewerRosterFromArgs({ author: 'claude', tokens: [], values: {} })
  });
  const task = JSON.parse(await fsp.readFile(path.join(repoRoot, '.plan-forge', 'default-roster', 'task.json'), 'utf8'));
  assert.deepEqual(task.reviewers, [{ provider: 'codex', model: null, effort: 'high', claudeMaxBudgetUsd: null }]);
  assert.equal('reviewer' in task, false);
  assert.equal('reviewerModel' in task, false);
  assert.equal('reviewerEffort' in task, false);
  assert.equal('claudeReviewerMaxBudgetUsd' in task, false);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { collectFindings, hasStalledCriticalFinding, normalizeReviewerOutput, validateAuthorResolutions } from '../lib/findings.mjs';

const emptyOverrides = { entries: [] };

function wrapper(round, previousFindings, newFindings) {
  return { meta: { round }, review: { verdict: 'changes_requested', previousFindings, newFindings, summary: '' } };
}

const finding = {
  id: 'F001', relatedToFindingId: null, noveltyRationale: 'new issue', severity: 'blocker', category: 'correctness',
  planSection: 'Implementation', problem: 'broken', evidence: ['src/a.js'], requiredChange: 'fix it'
};

test('critical streak starts at zero and needs two failed re-reviews', () => {
  const round1 = wrapper(1, [], [finding]);
  let state = collectFindings([round1], emptyOverrides);
  assert.equal(state.get('F001').criticalReviewStreak, 0);
  assert.equal(hasStalledCriticalFinding(state), false);

  const stillOpen = { id: 'F001', status: 'still_open', effectiveSeverity: null, explanation: 'not fixed' };
  const round2 = wrapper(2, [stillOpen], []);
  state = collectFindings([round1, round2], emptyOverrides);
  assert.equal(state.get('F001').criticalReviewStreak, 1);
  assert.equal(hasStalledCriticalFinding(state), false);

  const round3 = wrapper(3, [stillOpen], []);
  state = collectFindings([round1, round2, round3], emptyOverrides);
  assert.equal(state.get('F001').criticalReviewStreak, 2);
  assert.equal(hasStalledCriticalFinding(state), true);
});

test('normalization assigns IDs and validates computed verdict', () => {
  const output = {
    verdict: 'changes_requested', previousFindings: [],
    newFindings: [{ ...finding, id: null }], summary: 'one blocker'
  };
  const result = normalizeReviewerOutput(output, { round: 1, priorReviews: [], overrides: emptyOverrides });
  assert.equal(result.normalized.newFindings[0].id, 'F001');
});

test('redundant effectiveSeverity echoes normalize to null; real unrequested changes reject', () => {
  const round1 = wrapper(1, [], [finding]);
  const base = { id: 'F001', explanation: 'checked' };
  const run = (disposition) => normalizeReviewerOutput(
    { verdict: 'approved', previousFindings: [disposition], newFindings: [], summary: '' },
    { round: 2, priorReviews: [round1], overrides: emptyOverrides }
  );

  const resolvedEcho = run({ ...base, status: 'resolved', effectiveSeverity: 'blocker' });
  assert.equal(resolvedEcho.normalized.previousFindings[0].effectiveSeverity, null);
  assert.equal(resolvedEcho.coercions.length, 1);

  const openEcho = normalizeReviewerOutput(
    {
      verdict: 'changes_requested',
      previousFindings: [{ ...base, status: 'still_open', effectiveSeverity: 'blocker' }],
      newFindings: [],
      summary: ''
    },
    { round: 2, priorReviews: [round1], overrides: emptyOverrides }
  );
  assert.equal(openEcho.normalized.previousFindings[0].effectiveSeverity, null);

  assert.throws(
    () => run({ ...base, status: 'still_open', effectiveSeverity: 'minor' }),
    /without status severity_changed/
  );
});

test('author resolutions must cover required findings but may include extras', () => {
  const required = [{ id: 'F001' }];
  const covered = { findingId: 'F001', action: 'accepted', changedSections: ['Implementation'], explanation: 'fixed' };
  const extra = { findingId: 'F999', action: 'accepted', changedSections: [], explanation: 'voluntary cleanup' };
  validateAuthorResolutions([covered, extra], required);
  assert.throws(() => validateAuthorResolutions([extra], required), /missing resolutions for F001/);
  assert.throws(() => validateAuthorResolutions([covered, covered], required), /duplicate resolution/);
});

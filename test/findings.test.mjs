import assert from 'node:assert/strict';
import test from 'node:test';
import {
  activeFindings,
  blockingFindings,
  closedFindings,
  collectFindings,
  hasStalledCriticalFinding,
  normalizeReviewerOutput,
  validateAuthorResolutions
} from '../lib/findings.mjs';

const emptyOverrides = { entries: [] };

function wrapper(round, previousFindings, newFindings) {
  return { meta: { round }, review: { verdict: 'changes_requested', previousFindings, newFindings, summary: '' } };
}

const finding = {
  id: 'F001', relatedToFindingId: null, relationKind: null, noveltyRationale: 'new issue', severity: 'blocker',
  category: 'correctness', planSection: 'Implementation', problem: 'broken', evidence: ['src/a.js'],
  requiredChange: 'fix it'
};

const stillOpenAt = (id) => ({ id, status: 'still_open', effectiveSeverity: null, explanation: 'not fixed' });
const resolvedAt = (id) => ({ id, status: 'resolved', effectiveSeverity: null, explanation: 'fixed' });

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

test('every open severity stays active, but only blocker and major block approval', () => {
  const state = collectFindings([wrapper(1, [], [
    { ...finding, severity: 'blocker' },
    { ...finding, id: 'F002', severity: 'minor' },
    { ...finding, id: 'F003', severity: 'nit' }
  ])], emptyOverrides);

  assert.deepEqual(activeFindings(state).map((item) => item.id), ['F001', 'F002', 'F003']);
  assert.deepEqual(blockingFindings(state).map((item) => item.id), ['F001']);
  assert.deepEqual(closedFindings(state).map((item) => item.id), []);
});

test('an open minor must be dispositioned but does not force changes_requested', () => {
  const round1 = wrapper(1, [], [{ ...finding, severity: 'minor' }]);
  const review = (previousFindings) => normalizeReviewerOutput(
    { verdict: 'approved', previousFindings, newFindings: [], summary: '' },
    { round: 2, priorReviews: [round1], overrides: emptyOverrides }
  );

  // The old contract forbade dispositioning a minor, so it could never be closed.
  assert.throws(() => review([]), /missing=\[F001\]/);

  const carried = review([stillOpenAt('F001')]);
  assert.equal(carried.normalized.verdict, 'approved');
  assert.deepEqual(activeFindings(carried.findings).map((item) => item.id), ['F001']);

  const closed = review([resolvedAt('F001')]);
  assert.deepEqual(activeFindings(closed.findings), []);
  assert.deepEqual(closedFindings(closed.findings).map((item) => item.id), ['F001']);
});

test('a recurring critical inherits its ancestor streak across a new id', () => {
  const round1 = wrapper(1, [], [finding]);
  const recurrence = (id, ancestor) => ({ ...finding, id, relatedToFindingId: ancestor, relationKind: 'recurrence' });

  const round2 = wrapper(2, [resolvedAt('F001')], [recurrence('F002', 'F001')]);
  let state = collectFindings([round1, round2], emptyOverrides);
  assert.equal(state.get('F002').criticalReviewStreak, 1);
  assert.equal(hasStalledCriticalFinding(state), false);

  const round3 = wrapper(3, [resolvedAt('F002')], [recurrence('F003', 'F002')]);
  state = collectFindings([round1, round2, round3], emptyOverrides);
  assert.equal(state.get('F003').criticalReviewStreak, 2);
  assert.equal(hasStalledCriticalFinding(state), true);
});

test('an adjacent finding and a recurring non-critical both start a fresh streak', () => {
  const round1 = wrapper(1, [], [finding]);
  const related = (severity, relationKind) => ({
    ...finding, id: 'F002', severity, relatedToFindingId: 'F001', relationKind
  });

  const adjacent = collectFindings([round1, wrapper(2, [resolvedAt('F001')], [related('blocker', 'adjacent')])], emptyOverrides);
  assert.equal(adjacent.get('F002').criticalReviewStreak, 0);
  assert.equal(hasStalledCriticalFinding(adjacent), false);

  const downgraded = collectFindings([round1, wrapper(2, [resolvedAt('F001')], [related('minor', 'recurrence')])], emptyOverrides);
  assert.equal(downgraded.get('F002').criticalReviewStreak, 0);
});

test('a human override closes or downgrades, and only a close ends the obligation', () => {
  const round1 = wrapper(1, [], [finding]);
  const override = (disposition, effectiveSeverity) => ({
    entries: [{ findingId: 'F001', disposition, effectiveSeverity, reason: 'human call' }]
  });

  // Withdrawn: closed, so neither role hears about it again.
  const withdrawn = collectFindings([round1], override('withdrawn', null));
  assert.deepEqual(activeFindings(withdrawn), []);
  assert.deepEqual(closedFindings(withdrawn).map((item) => item.id), ['F001']);

  // Downgraded: no longer blocks, but it is still an open finding, so the
  // reviewer still owes it a disposition every round.
  const downgraded = collectFindings([round1], override('severity_changed', 'minor'));
  assert.deepEqual(activeFindings(downgraded).map((item) => item.id), ['F001']);
  assert.deepEqual(blockingFindings(downgraded), []);
  assert.throws(
    () => normalizeReviewerOutput(
      { verdict: 'approved', previousFindings: [], newFindings: [], summary: '' },
      { round: 2, priorReviews: [round1], overrides: override('severity_changed', 'minor') }
    ),
    /missing=\[F001\]/
  );
});

test('relationKind must agree with relatedToFindingId', () => {
  const round1 = wrapper(1, [], [finding]);
  const review = (extra) => normalizeReviewerOutput(
    {
      verdict: 'changes_requested',
      previousFindings: [stillOpenAt('F001')],
      newFindings: [{ ...finding, id: null, ...extra }],
      summary: ''
    },
    { round: 2, priorReviews: [round1], overrides: emptyOverrides }
  );

  assert.throws(() => review({ relatedToFindingId: 'F001', relationKind: null }), /relationKind/);
  assert.throws(() => review({ relatedToFindingId: null, relationKind: 'recurrence' }), /relationKind/);
  assert.throws(() => review({ relatedToFindingId: 'F404', relationKind: 'recurrence' }), /unknown id F404/);
  assert.equal(review({ relatedToFindingId: 'F001', relationKind: 'recurrence' }).normalized.newFindings[0].id, 'F002');
});

test('author resolutions must cover required findings but may include extras', () => {
  const required = [{ id: 'F001' }];
  const covered = { findingId: 'F001', action: 'accepted', changedSections: ['Implementation'], explanation: 'fixed' };
  const extra = { findingId: 'F999', action: 'accepted', changedSections: [], explanation: 'voluntary cleanup' };
  validateAuthorResolutions([covered, extra], required);
  assert.throws(() => validateAuthorResolutions([extra], required), /missing resolutions for F001/);
  assert.throws(() => validateAuthorResolutions([covered, covered], required), /duplicate resolution/);
});

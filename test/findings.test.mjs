import assert from 'node:assert/strict';
import test from 'node:test';
import {
  activeFindings,
  blockingFindings,
  closedFindings,
  collectFindings,
  hasStalledCriticalFinding,
  normalizeSlotReview,
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

test('capture normalization never allocates ids; the verdict self-check still runs', () => {
  const output = {
    verdict: 'changes_requested', previousFindings: [],
    newFindings: [{ ...finding, id: null }], summary: 'one blocker'
  };
  const result = normalizeSlotReview(output, { round: 1, priorReviews: [], overrides: emptyOverrides });
  // Allocation is the merge's job (test/merge.test.mjs); a capture keeps null.
  assert.equal(result.normalized.newFindings[0].id, null);
  assert.throws(
    () => normalizeSlotReview({ ...output, verdict: 'approved' }, { round: 1, priorReviews: [], overrides: emptyOverrides }),
    /verdict must be changes_requested/
  );
});

test('redundant effectiveSeverity echoes normalize to null; real unrequested changes reject', () => {
  const round1 = wrapper(1, [], [finding]);
  const base = { id: 'F001', explanation: 'checked' };
  const run = (disposition) => normalizeSlotReview(
    { verdict: 'approved', previousFindings: [disposition], newFindings: [], summary: '' },
    { round: 2, priorReviews: [round1], overrides: emptyOverrides }
  );

  const resolvedEcho = run({ ...base, status: 'resolved', effectiveSeverity: 'blocker' });
  assert.equal(resolvedEcho.normalized.previousFindings[0].effectiveSeverity, null);
  assert.equal(resolvedEcho.coercions.length, 1);

  const openEcho = normalizeSlotReview(
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
  const review = (previousFindings) => normalizeSlotReview(
    { verdict: 'approved', previousFindings, newFindings: [], summary: '' },
    { round: 2, priorReviews: [round1], overrides: emptyOverrides }
  );

  // The old contract forbade dispositioning a minor, so it could never be closed.
  assert.throws(() => review([]), /missing=\[F001\]/);

  // The fold over a committed round is the authority the capture feeds into.
  const fold = (result) => collectFindings(
    [round1, { meta: { round: 2 }, review: result.normalized }],
    emptyOverrides
  );
  const carried = review([stillOpenAt('F001')]);
  assert.equal(carried.normalized.verdict, 'approved');
  assert.deepEqual(activeFindings(fold(carried)).map((item) => item.id), ['F001']);

  const closed = review([resolvedAt('F001')]);
  assert.deepEqual(activeFindings(fold(closed)), []);
  assert.deepEqual(closedFindings(fold(closed)).map((item) => item.id), ['F001']);
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
    () => normalizeSlotReview(
      { verdict: 'approved', previousFindings: [], newFindings: [], summary: '' },
      { round: 2, priorReviews: [round1], overrides: override('severity_changed', 'minor') }
    ),
    /missing=\[F001\]/
  );
});

test('relationKind must agree with relatedToFindingId', () => {
  const round1 = wrapper(1, [], [finding]);
  const review = (extra) => normalizeSlotReview(
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
  // A prior-round reference passes through verbatim; allocation happens at merge.
  const accepted = review({ relatedToFindingId: 'F001', relationKind: 'recurrence' }).normalized.newFindings[0];
  assert.equal(accepted.id, null);
  assert.equal(accepted.relatedToFindingId, 'F001');
});

test('author resolutions must cover required findings but may include extras', () => {
  const required = [{ id: 'F001' }];
  const covered = { findingId: 'F001', action: 'accepted', changedSections: ['Implementation'], explanation: 'fixed' };
  const extra = { findingId: 'F999', action: 'accepted', changedSections: [], explanation: 'voluntary cleanup' };
  validateAuthorResolutions([covered, extra], required);
  assert.throws(() => validateAuthorResolutions([extra], required), /missing resolutions for F001/);
  assert.throws(() => validateAuthorResolutions([covered, covered], required), /duplicate resolution/);
});

test('one resolution may cover several equivalent findings exactly once', () => {
  const required = [{ id: 'F001' }, { id: 'F002' }, { id: 'F003' }];
  const covering = (covers) => ({
    findingId: 'F001', action: 'accepted', changedSections: ['Implementation'],
    explanation: 'one fix answers both', coversFindingIds: covers
  });
  const other = { findingId: 'F003', action: 'rejected', changedSections: [], explanation: 'not a defect' };

  // Test 9: one resolution covers many.
  validateAuthorResolutions([covering(['F002']), other], required);

  // Test 10: double coverage rejected — two resolutions both answering F002.
  assert.throws(
    () => validateAuthorResolutions(
      [covering(['F002']), { ...other, coversFindingIds: ['F002'] }],
      required
    ),
    /duplicate resolution for F002/
  );

  // Test 11: coverage gaps still caught.
  assert.throws(
    () => validateAuthorResolutions([covering(['F002'])], required),
    /missing resolutions for F003/
  );
});

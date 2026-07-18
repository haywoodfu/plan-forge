import assert from 'node:assert/strict';
import test from 'node:test';
import {
  collectFindings,
  normalizeReviewerOutput,
  normalizeSlotReview
} from '../lib/findings.mjs';
import { arbitrate, mergeRoundReviews, outcomeRank } from '../lib/merge.mjs';

const emptyOverrides = { entries: [] };

const finding = {
  id: null, relatedToFindingId: null, relationKind: null, noveltyRationale: 'new issue', severity: 'blocker',
  category: 'correctness', planSection: 'Implementation', problem: 'broken', evidence: ['src/a.js'],
  requiredChange: 'fix it'
};

function wrapper(round, previousFindings, newFindings) {
  return { meta: { round }, review: { verdict: 'changes_requested', previousFindings, newFindings, summary: '' } };
}

function slotEntry(slot, review, meta = {}) {
  return {
    wrapper: {
      meta: {
        schemaVersion: 1, role: 'reviewer', round: meta.round ?? 1, slot,
        provider: meta.provider ?? 'codex', model: meta.model ?? `${slot}-model`,
        cliVersion: 'test', promptSha256: 'a'.repeat(64), effort: 'high',
        startedAt: meta.startedAt ?? '2026-01-01T00:00:00.000Z',
        completedAt: meta.completedAt ?? '2026-01-01T00:05:00.000Z',
        usage: null, costUsd: null, sessionId: null,
        gitHead: null, gitDirty: null, planSha256: 'b'.repeat(64),
        ...meta
      },
      review
    },
    fileSha256: `d${slot.slice(1)}`.padEnd(64, '0')
  };
}

const ROSTER_2 = [
  { id: 'R1', index: 1, provider: 'claude', model: 'opus', effort: 'high', claudeMaxBudgetUsd: null },
  { id: 'R2', index: 2, provider: 'codex', model: 'gpt', effort: 'high', claudeMaxBudgetUsd: null }
];
const ROSTER_1 = [{ id: 'R1', index: 1, provider: 'codex', model: null, effort: null, claudeMaxBudgetUsd: null }];

function merge({ roster, captures, priorReviews = [], overrides = emptyOverrides, round = 1 }) {
  return mergeRoundReviews({
    round,
    roster,
    slotReviews: new Map(captures),
    promptSha256: 'a'.repeat(64),
    priorReviews,
    overrides,
    planSha256: 'b'.repeat(64)
  });
}

test('id allocation follows roster order, never completion order (AC2)', () => {
  const r1 = { verdict: 'changes_requested', previousFindings: [], newFindings: [{ ...finding, problem: 'from R1' }], summary: 'r1' };
  const r2 = { verdict: 'changes_requested', previousFindings: [], newFindings: [{ ...finding, problem: 'from R2' }], summary: 'r2' };
  // R2's capture is inserted first — completion order must not matter.
  const merged = merge({ roster: ROSTER_2, captures: [['R2', slotEntry('R2', r2)], ['R1', slotEntry('R1', r1)]] });
  assert.deepEqual(
    merged.review.newFindings.map((item) => [item.id, item.problem, item.raisedBy, item.sourceIndex]),
    [['F001', 'from R1', 'R1', 0], ['F002', 'from R2', 'R2', 0]]
  );
});

test('id allocation is race-free: N slots, distinct ids, foldable (AC2)', () => {
  const two = (label) => ({
    verdict: 'changes_requested', previousFindings: [],
    newFindings: [{ ...finding, problem: `${label} a` }, { ...finding, problem: `${label} b` }], summary: label
  });
  const merged = merge({ roster: ROSTER_2, captures: [['R1', slotEntry('R1', two('r1'))], ['R2', slotEntry('R2', two('r2'))]] });
  const ids = merged.review.newFindings.map((item) => item.id);
  assert.deepEqual(ids, ['F001', 'F002', 'F003', 'F004']);
  assert.equal(new Set(ids).size, 4);
  // The fold accepts the merged doc without a duplicate-id throw.
  assert.equal(collectFindings([merged], emptyOverrides).size, 4);
});

test('arbitration: most-open-wins with both dispositions recorded (AC3)', () => {
  const prior = wrapper(1, [], [{ ...finding, id: 'F001' }]);
  const dispose = (status, explanation) => ({ id: 'F001', status, effectiveSeverity: null, explanation });
  const r1 = { verdict: 'approved', previousFindings: [dispose('resolved', 'looks fixed')], newFindings: [], summary: 'r1' };
  const r2 = { verdict: 'changes_requested', previousFindings: [dispose('still_open', 'still broken')], newFindings: [], summary: 'r2' };
  const merged = merge({
    roster: ROSTER_2, round: 2, priorReviews: [prior],
    captures: [['R1', slotEntry('R1', r1, { round: 2 })], ['R2', slotEntry('R2', r2, { round: 2 })]]
  });
  const entry = merged.review.previousFindings[0];
  assert.equal(entry.status, 'still_open');
  assert.equal(entry.explanation, 'still broken');
  assert.equal(entry.arbitration.winner, 'R2');
  assert.deepEqual(entry.arbitration.dispositions.map((d) => [d.slot, d.status]), [['R1', 'resolved'], ['R2', 'still_open']]);
  assert.equal(merged.review.verdict, 'changes_requested');
});

test('arbitration: severity ladder ranks severity_changed against still_open (AC3)', () => {
  const prior = wrapper(1, [], [{ ...finding, id: 'F001' }]);
  const run = (d1, d2) => merge({
    roster: ROSTER_2, round: 2, priorReviews: [prior],
    captures: [
      ['R1', slotEntry('R1', { verdict: d1.verdict, previousFindings: [d1.d], newFindings: [], summary: 'r1' }, { round: 2 })],
      ['R2', slotEntry('R2', { verdict: d2.verdict, previousFindings: [d2.d], newFindings: [], summary: 'r2' }, { round: 2 })]
    ]
  }).review.previousFindings[0];

  // severity_changed→minor vs still_open at blocker → blocker wins.
  const downgradeVsOpen = run(
    { verdict: 'approved', d: { id: 'F001', status: 'severity_changed', effectiveSeverity: 'minor', explanation: 'overstated' } },
    { verdict: 'changes_requested', d: { id: 'F001', status: 'still_open', effectiveSeverity: null, explanation: 'still a blocker' } }
  );
  assert.equal(downgradeVsOpen.status, 'still_open');
  assert.equal(downgradeVsOpen.arbitration.winner, 'R2');

  // severity_changed→major vs severity_changed→minor → major wins.
  const majorVsMinor = run(
    { verdict: 'changes_requested', d: { id: 'F001', status: 'severity_changed', effectiveSeverity: 'major', explanation: 'major' } },
    { verdict: 'approved', d: { id: 'F001', status: 'severity_changed', effectiveSeverity: 'minor', explanation: 'minor' } }
  );
  assert.equal(majorVsMinor.effectiveSeverity, 'major');
  assert.equal(majorVsMinor.arbitration.winner, 'R1');
});

test('arbitration: unanimous close closes; ties go to the lowest slot (AC3)', () => {
  const prior = wrapper(1, [], [{ ...finding, id: 'F001' }]);
  const resolved = (why) => ({ id: 'F001', status: 'resolved', effectiveSeverity: null, explanation: why });
  const merged = merge({
    roster: ROSTER_2, round: 2, priorReviews: [prior],
    captures: [
      ['R1', slotEntry('R1', { verdict: 'approved', previousFindings: [resolved('fixed, says R1')], newFindings: [], summary: 'r1' }, { round: 2 })],
      ['R2', slotEntry('R2', { verdict: 'approved', previousFindings: [resolved('fixed, says R2')], newFindings: [], summary: 'r2' }, { round: 2 })]
    ]
  });
  const entry = merged.review.previousFindings[0];
  assert.equal(entry.status, 'resolved');
  assert.equal(entry.arbitration.winner, 'R1');
  assert.equal(merged.review.verdict, 'approved');
  const after = collectFindings([prior, merged], emptyOverrides);
  assert.equal(after.get('F001').closed, true);
});

test('the verdict is composed from the merged set, not inherited from any slot (AC4)', () => {
  // R1 self-consistently approved; R2 filed a new blocker.
  const r1 = { verdict: 'approved', previousFindings: [], newFindings: [], summary: 'clean' };
  const r2 = { verdict: 'changes_requested', previousFindings: [], newFindings: [{ ...finding }], summary: 'blocker' };
  const merged = merge({ roster: ROSTER_2, captures: [['R1', slotEntry('R1', r1)], ['R2', slotEntry('R2', r2)]] });
  assert.equal(merged.review.verdict, 'changes_requested');

  const clean = merge({
    roster: ROSTER_2,
    captures: [
      ['R1', slotEntry('R1', { verdict: 'approved', previousFindings: [], newFindings: [], summary: 'ok' })],
      ['R2', slotEntry('R2', { verdict: 'approved', previousFindings: [], newFindings: [], summary: 'ok' })]
    ]
  });
  assert.equal(clean.review.verdict, 'approved');
});

test('an N=1 merge is today\'s normalizer, wrapped (AC1)', async () => {
  const prior = wrapper(1, [], [{ ...finding, id: 'F001' }]);
  const output = {
    verdict: 'changes_requested',
    previousFindings: [{ id: 'F001', status: 'still_open', effectiveSeverity: null, explanation: 'unfixed' }],
    newFindings: [{ ...finding, problem: 'another' }],
    summary: 'one more'
  };
  const oracle = normalizeReviewerOutput(structuredClone(output), { round: 2, priorReviews: [prior], overrides: emptyOverrides });
  const capture = normalizeSlotReview(structuredClone(output), { round: 2, priorReviews: [prior], overrides: emptyOverrides });
  const merged = merge({
    roster: ROSTER_1, round: 2, priorReviews: [prior],
    captures: [['R1', slotEntry('R1', capture.normalized, { round: 2, provider: 'codex', model: null })]]
  });

  assert.equal(merged.meta.schemaVersion, 2);
  assert.equal(merged.review.verdict, oracle.normalized.verdict);
  assert.equal(merged.review.summary, oracle.normalized.summary);
  const strip = (items) => items.map(({ raisedBy, sourceIndex, arbitration, ...rest }) => rest);
  assert.deepEqual(strip(merged.review.newFindings), oracle.normalized.newFindings);
  assert.deepEqual(strip(merged.review.previousFindings), oracle.normalized.previousFindings);

  // The merge cannot emit an artifact its own loader rejects.
  const { loadSchemas } = await import('../lib/schema.mjs');
  const { toolRoot } = await import('./helpers.mjs');
  const schemas = await loadSchemas(toolRoot);
  const valid = schemas.validateMergedReview(merged);
  assert.equal(valid, true, JSON.stringify(schemas.validateMergedReview.errors));
});

test('overrides are applied after arbitration, never voted on (AC4)', () => {
  const prior = wrapper(1, [], [{ ...finding, id: 'F001' }]);
  // A human pinned F001 at blocker; both slots downgrade it to nit.
  const overrides = { entries: [{ findingId: 'F001', disposition: 'severity_changed', effectiveSeverity: 'blocker', reason: 'human call' }] };
  const nit = { id: 'F001', status: 'severity_changed', effectiveSeverity: 'nit', explanation: 'cosmetic' };
  const merged = merge({
    roster: ROSTER_2, round: 2, priorReviews: [prior], overrides,
    captures: [
      ['R1', slotEntry('R1', { verdict: 'changes_requested', previousFindings: [nit], newFindings: [], summary: 'r1' }, { round: 2 })],
      ['R2', slotEntry('R2', { verdict: 'changes_requested', previousFindings: [nit], newFindings: [], summary: 'r2' }, { round: 2 })]
    ]
  });
  // collectFindings applies overrides last, so the merged verdict still blocks.
  assert.equal(merged.review.verdict, 'changes_requested');
});

test('a same-output relation survives the capture/merge split unchanged at N=1 (test 28)', () => {
  const prior = wrapper(1, [], [{ ...finding, id: 'F001' }, { ...finding, id: 'F002', severity: 'minor' }]);
  const dispositions = [
    { id: 'F001', status: 'resolved', effectiveSeverity: null, explanation: 'fixed' },
    { id: 'F002', status: 'resolved', effectiveSeverity: null, explanation: 'fixed' }
  ];
  // base is 3: finding A predicts F003, B names it as a same-output recurrence.
  const output = {
    verdict: 'changes_requested',
    previousFindings: dispositions,
    newFindings: [
      { ...finding, problem: 'A' },
      { ...finding, problem: 'B', relatedToFindingId: 'F003', relationKind: 'recurrence' }
    ],
    summary: 'pair'
  };
  const oracle = normalizeReviewerOutput(structuredClone(output), { round: 2, priorReviews: [prior], overrides: emptyOverrides });
  const capture = normalizeSlotReview(structuredClone(output), { round: 2, priorReviews: [prior], overrides: emptyOverrides });

  // Capture: ids stay null; the self-reference is provisional.
  assert.deepEqual(capture.normalized.newFindings.map((item) => item.id), [null, null]);
  assert.equal(capture.normalized.newFindings[1].relatedToFindingId, 'P1');

  const merged = merge({
    roster: ROSTER_1, round: 2, priorReviews: [prior],
    captures: [['R1', slotEntry('R1', capture.normalized, { round: 2 })]]
  });
  assert.equal(merged.review.newFindings[0].id, 'F003');
  assert.equal(merged.review.newFindings[1].id, 'F004');
  assert.equal(merged.review.newFindings[1].relatedToFindingId, 'F003');
  assert.equal(merged.review.newFindings[1].relationKind, 'recurrence');
  const strip = (items) => items.map(({ raisedBy, sourceIndex, ...rest }) => rest);
  assert.deepEqual(strip(merged.review.newFindings), oracle.normalized.newFindings);

  // Streak inheritance matches the oracle exactly.
  const mergedState = collectFindings([prior, merged], emptyOverrides);
  const oracleState = collectFindings([prior, { meta: { round: 2 }, review: oracle.normalized }], emptyOverrides);
  assert.equal(mergedState.get('F003').criticalReviewStreak, oracleState.get('F003').criticalReviewStreak);
  assert.equal(mergedState.get('F004').criticalReviewStreak, oracleState.get('F004').criticalReviewStreak);
  assert.equal(mergedState.get('F004').criticalReviewStreak, 1);

  // Rejections still hold with today's messages.
  const reject = (related) => () => normalizeSlotReview(
    {
      ...output,
      newFindings: [
        { ...finding, problem: 'A', relatedToFindingId: related, relationKind: 'recurrence' },
        { ...finding, problem: 'B' }
      ]
    },
    { round: 2, priorReviews: [prior], overrides: emptyOverrides }
  );
  assert.throws(reject('F004'), /unknown id F004/);      // forward reference
  assert.throws(reject('F099'), /unknown id F099/);      // past the end
  // A prior-round reference is accepted and passes through unrewritten.
  const priorRef = normalizeSlotReview(
    {
      ...output,
      newFindings: [
        { ...finding, problem: 'A', relatedToFindingId: 'F001', relationKind: 'recurrence' },
        { ...finding, problem: 'B' }
      ]
    },
    { round: 2, priorReviews: [prior], overrides: emptyOverrides }
  );
  assert.equal(priorRef.normalized.newFindings[0].relatedToFindingId, 'F001');
});

test('a slot-local reference never binds to a peer\'s finding (test 29)', () => {
  const prior = wrapper(1, [], [{ ...finding, id: 'F001' }, { ...finding, id: 'F002', severity: 'minor' }]);
  const dispositions = [
    { id: 'F001', status: 'resolved', effectiveSeverity: null, explanation: 'fixed' },
    { id: 'F002', status: 'resolved', effectiveSeverity: null, explanation: 'fixed' }
  ];
  const r1Output = {
    verdict: 'changes_requested',
    previousFindings: dispositions,
    newFindings: [{ ...finding, problem: 'R1 a' }, { ...finding, problem: 'R1 b' }],
    summary: 'r1'
  };
  // R2 names F003 — its own position-predicted first finding, which at N=2 is
  // actually R1's allocated id. The rewrite must bind it slot-locally.
  const r2Output = {
    verdict: 'changes_requested',
    previousFindings: dispositions,
    newFindings: [
      { ...finding, problem: 'R2 a' },
      { ...finding, problem: 'R2 b', relatedToFindingId: 'F003', relationKind: 'recurrence' }
    ],
    summary: 'r2'
  };
  const norm = (output) => normalizeSlotReview(output, { round: 2, priorReviews: [prior], overrides: emptyOverrides }).normalized;
  const merged = merge({
    roster: ROSTER_2, round: 2, priorReviews: [prior],
    captures: [
      ['R1', slotEntry('R1', norm(r1Output), { round: 2 })],
      ['R2', slotEntry('R2', norm(r2Output), { round: 2 })]
    ]
  });
  assert.deepEqual(
    merged.review.newFindings.map((item) => [item.id, item.raisedBy]),
    [['F003', 'R1'], ['F004', 'R1'], ['F005', 'R2'], ['F006', 'R2']]
  );
  // R2's reference resolves to its OWN first finding, not R1's F003.
  assert.equal(merged.review.newFindings[3].relatedToFindingId, 'F005');
  const state = collectFindings([prior, merged], emptyOverrides);
  assert.equal(state.get('F006').criticalReviewStreak, 1);   // inherits from F005
  assert.equal(state.get('F003').criticalReviewStreak, 0);   // untouched
});

test('a tampered slot-local reference is a named merge error, not a committed artifact (M2)', () => {
  const capture = {
    verdict: 'changes_requested',
    previousFindings: [],
    newFindings: [{ ...finding, relatedToFindingId: 'P9', relationKind: 'recurrence' }],
    summary: 'tampered'
  };
  assert.throws(
    () => merge({ roster: ROSTER_1, captures: [['R1', slotEntry('R1', capture)]] }),
    /invalid slot-local reference P9/
  );
});

test('outcomeRank and arbitrate are exported and total', () => {
  const finding = { effectiveSeverity: 'major' };
  assert.equal(outcomeRank({ status: 'resolved' }, finding), 0);
  assert.equal(outcomeRank({ status: 'withdrawn' }, finding), 0);
  assert.equal(outcomeRank({ status: 'still_open' }, finding), 3);
  assert.equal(outcomeRank({ status: 'severity_changed', effectiveSeverity: 'blocker' }, finding), 4);
  const winner = arbitrate(finding, [
    { slot: 'R1', status: 'resolved' },
    { slot: 'R2', status: 'still_open' },
    { slot: 'R3', status: 'still_open' }
  ]);
  assert.equal(winner.slot, 'R2');
});

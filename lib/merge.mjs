// The barrier merge: N slot captures in, one merged round review out. This
// module owns everything that must not happen concurrently — finding-id
// allocation, disposition arbitration, verdict composition — which is why it
// runs exactly once, single-threaded, after every slot has committed.
// mergeRoundReviews does no I/O: captures and their file hashes are passed in,
// so the function is pure and the unit suite needs no filesystem.
import { activeFindings, blockingFindings, collectFindings, nextFindingNumber } from './findings.mjs';

const SEVERITY_RANK = { blocker: 4, major: 3, minor: 2, nit: 1 };
const CLOSED = new Set(['resolved', 'withdrawn']);

// A closed disposition ranks 0; an open one ranks at the severity it leaves the
// finding at. still_open inherits the finding's current effective severity;
// severity_changed speaks for itself.
export function outcomeRank(disposition, finding) {
  if (CLOSED.has(disposition.status)) return 0;
  return SEVERITY_RANK[disposition.status === 'severity_changed'
    ? disposition.effectiveSeverity
    : finding.effectiveSeverity];
}

// Most-open-wins: a finding stays open at the highest severity any reviewer
// assigns it, and closes only if every reviewer closes it. Dispositions arrive
// in roster order, so strict `>` makes ties go to the lowest slot index without
// a second comparator. Any weaker rule would let a plan close a defect one
// reviewer is on the record as still seeing — a merged jury weaker than its
// strictest member, the inversion of why fan-out exists.
export function arbitrate(finding, dispositions) {
  return dispositions.reduce((winner, candidate) =>
    outcomeRank(candidate, finding) > outcomeRank(winner, finding) ? candidate : winner);
}

export function mergeRoundReviews({ round, roster, slotReviews, promptSha256, priorReviews, overrides, planSha256 }) {
  for (const slot of roster) {
    if (!slotReviews.has(slot.id)) throw new Error(`cannot merge round ${round}: slot ${slot.id} has no committed review`);
  }
  const before = collectFindings(priorReviews, overrides);
  const active = activeFindings(before);

  // Every slot dispositioned every active finding (normalizeSlotReview enforces
  // completeness per capture), so each finding arrives with exactly N votes.
  const previousFindings = active.map((finding) => {
    const dispositions = roster.map((slot) => {
      const capture = slotReviews.get(slot.id).wrapper.review;
      const disposition = capture.previousFindings.find((item) => item.id === finding.id);
      if (!disposition) throw new Error(`cannot merge round ${round}: slot ${slot.id} did not disposition ${finding.id}`);
      return {
        slot: slot.id,
        status: disposition.status,
        effectiveSeverity: disposition.effectiveSeverity,
        explanation: disposition.explanation
      };
    });
    const winner = arbitrate(finding, dispositions);
    return {
      id: finding.id,
      status: winner.status,
      effectiveSeverity: winner.effectiveSeverity,
      explanation: winner.explanation,
      arbitration: { winner: winner.slot, dispositions }
    };
  });

  // Allocation walks the roster in slot order and each capture in array order,
  // so ids depend only on (prior state, roster order, capture order) — never on
  // which slot finished first. A slot-local `P<k>` reference resolves against
  // this slot's own allocation; the range guard makes a tampered capture a
  // named error here, before anything is committed, rather than an invalid
  // artifact discovered at the next load.
  let next = nextFindingNumber(before);
  const newFindings = [];
  for (const slot of roster) {
    const captured = slotReviews.get(slot.id).wrapper.review.newFindings;
    const ids = captured.map(() => `F${String(next++).padStart(3, '0')}`);
    captured.forEach((finding, sourceIndex) => {
      let relatedToFindingId = finding.relatedToFindingId;
      const selfRef = /^P(\d+)$/.exec(relatedToFindingId ?? '');
      if (selfRef) {
        const index = Number(selfRef[1]) - 1;
        if (index < 0 || index >= sourceIndex) {
          throw new Error(`cannot merge round ${round}: slot ${slot.id} carries an invalid slot-local reference ${relatedToFindingId}`);
        }
        relatedToFindingId = ids[index];
      }
      newFindings.push({ ...finding, id: ids[sourceIndex], relatedToFindingId, raisedBy: slot.id, sourceIndex });
    });
  }

  // The verdict is composed from the merged set through the same functions that
  // compute the gate — no slot's own verdict is ever the round's verdict.
  const after = collectFindings(
    [...priorReviews, { meta: { round }, review: { previousFindings, newFindings } }],
    overrides
  );
  const verdict = blockingFindings(after).length ? 'changes_requested' : 'approved';

  const summaries = roster.map((slot) => ({ slot: slot.id, summary: slotReviews.get(slot.id).wrapper.review.summary }));
  const summary = summaries.length === 1
    ? summaries[0].summary
    : summaries.map((item) => `${item.slot}: ${item.summary}`).join('\n\n');

  const metas = roster.map((slot) => slotReviews.get(slot.id).wrapper.meta);
  const meta = {
    schemaVersion: 2,
    role: 'reviewer',
    round,
    planSha256,
    promptSha256,
    // Earliest slot start, so the round's wall-clock span stays readable from
    // one artifact; completedAt is the merge instant — the round's canonical
    // completion time, frozen with the artifact.
    startedAt: metas.map((item) => item.startedAt).sort()[0],
    completedAt: new Date().toISOString(),
    gitHead: metas[0].gitHead,
    gitDirty: metas[0].gitDirty,
    reviewers: roster.map((slot) => {
      const { wrapper, fileSha256 } = slotReviews.get(slot.id);
      const m = wrapper.meta;
      return {
        slot: slot.id,
        provider: m.provider,
        model: m.model ?? null,
        cliVersion: m.cliVersion ?? null,
        effort: m.effort ?? null,
        startedAt: m.startedAt,
        completedAt: m.completedAt,
        usage: m.usage ?? null,
        costUsd: m.costUsd ?? null,
        sessionId: m.sessionId ?? null,
        captureSha256: fileSha256
      };
    })
  };

  return { meta, review: { verdict, summary, summaries, previousFindings, newFindings } };
}

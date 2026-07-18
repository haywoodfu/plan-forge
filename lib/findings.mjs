const CRITICAL = new Set(['blocker', 'major']);
const CLOSED = new Set(['resolved', 'withdrawn']);
const RELATION_KINDS = new Set(['recurrence', 'adjacent']);

export function isCritical(severity) {
  return CRITICAL.has(severity);
}

function applyReviewToMap(map, wrapper, round) {
  const review = wrapper.review;
  for (const disposition of review.previousFindings) {
    const finding = map.get(disposition.id);
    if (!finding) throw new Error(`review references unknown finding ${disposition.id}`);
    finding.lastReviewedRound = round;
    finding.lastStatus = disposition.status;
    finding.lastExplanation = disposition.explanation;

    if (CLOSED.has(disposition.status)) {
      // The streak survives the close so a later recurrence can inherit it. A
      // closed finding never stalls on its own; hasStalledCriticalFinding
      // filters on `closed`.
      finding.closed = true;
      continue;
    }

    finding.closed = false;
    if (disposition.status === 'severity_changed') {
      finding.effectiveSeverity = disposition.effectiveSeverity;
    }
    if (isCritical(finding.effectiveSeverity)) {
      finding.criticalReviewStreak += 1;
    } else {
      finding.criticalReviewStreak = 0;
    }
  }

  for (const item of review.newFindings) {
    if (!item.id) throw new Error('persisted new finding is missing an assigned id');
    if (map.has(item.id)) throw new Error(`duplicate finding id ${item.id}`);
    // A recurrence is the same defect wearing a new id: it continues its
    // ancestor's streak instead of resetting the stall detector to zero.
    // Reviews written before relationKind existed carry undefined and inherit
    // nothing, which matches their old behavior.
    const ancestor = item.relationKind === 'recurrence' ? map.get(item.relatedToFindingId) : null;
    map.set(item.id, {
      ...item,
      introducedRound: round,
      lastReviewedRound: round,
      originalSeverity: item.severity,
      effectiveSeverity: item.severity,
      lastStatus: 'new',
      closed: false,
      criticalReviewStreak: ancestor && isCritical(item.severity) ? ancestor.criticalReviewStreak + 1 : 0,
      override: null
    });
  }
}

function applyOverrides(map, overrides) {
  for (const entry of overrides.entries || []) {
    const finding = map.get(entry.findingId);
    if (!finding) throw new Error(`override references unknown finding ${entry.findingId}`);
    finding.override = entry;
    if (entry.disposition === 'withdrawn') {
      finding.closed = true;
      finding.lastStatus = 'withdrawn';
      finding.criticalReviewStreak = 0;
    } else if (entry.disposition === 'severity_changed') {
      finding.closed = false;
      finding.lastStatus = 'severity_changed';
      finding.effectiveSeverity = entry.effectiveSeverity;
      if (!isCritical(finding.effectiveSeverity)) finding.criticalReviewStreak = 0;
    }
  }
}

export function collectFindings(reviewWrappers, overrides = { entries: [] }) {
  const map = new Map();
  const sorted = [...reviewWrappers].sort((a, b) => a.meta.round - b.meta.round);
  for (const wrapper of sorted) applyReviewToMap(map, wrapper, wrapper.meta.round);
  applyOverrides(map, overrides);
  return map;
}

function byId(a, b) {
  return a.id.localeCompare(b.id);
}

// Everything still open, at every severity. Both roles must account for each of
// these every round: the reviewer dispositions them, the author resolves them.
// Findings outside this set are invisible to both roles, so a severity excluded
// here can never be closed and gets re-raised under a fresh id forever.
export function activeFindings(findings) {
  return [...findings.values()].filter((finding) => !finding.closed).sort(byId);
}

// The approval gate. Narrower than active on purpose: an open minor must still
// be answered, but it does not hold the plan hostage.
export function blockingFindings(findings) {
  return activeFindings(findings).filter((finding) => isCritical(finding.effectiveSeverity));
}

// History supplied to the reviewer for recurrence detection, never for
// dispositioning.
export function closedFindings(findings) {
  return [...findings.values()].filter((finding) => finding.closed).sort(byId);
}

export function hasStalledCriticalFinding(findings) {
  return [...findings.values()].some(
    (finding) => !finding.closed && isCritical(finding.effectiveSeverity) && finding.criticalReviewStreak >= 2
  );
}

export function nextFindingNumber(findings) {
  return [...findings.keys()]
    .map((id) => Number(/^F(\d+)$/.exec(id)?.[1] || 0))
    .reduce((max, value) => Math.max(max, value), 0) + 1;
}

// One resolution may answer several semantically equivalent findings: its own
// findingId plus everything in coversFindingIds. Read through ?? [] so legacy
// author outputs — which predate the field — keep today's one-id semantics.
export function coveredIds(resolution) {
  return [resolution.findingId, ...(resolution.coversFindingIds ?? [])];
}

export function validateAuthorResolutions(resolutions, requiredFindings) {
  const expected = new Set(requiredFindings.map((finding) => finding.id));
  const seen = new Set();
  for (const resolution of resolutions) {
    for (const id of coveredIds(resolution)) {
      if (seen.has(id)) throw new Error(`duplicate resolution for ${id}`);
      seen.add(id);
    }
    if (!resolution.explanation.trim()) throw new Error(`resolution ${resolution.findingId} needs an explanation`);
    if (resolution.action === 'superseded' && resolution.changedSections.length === 0) {
      throw new Error(`superseded resolution ${resolution.findingId} must name changed sections`);
    }
  }
  const missing = [...expected].filter((id) => !seen.has(id));
  if (missing.length) throw new Error(`author output is missing resolutions for ${missing.join(', ')}`);
}

function normalizeDispositions(output, before) {
  const required = activeFindings(before);
  const expectedIds = new Set(required.map((finding) => finding.id));
  const actualIds = new Set(output.previousFindings.map((finding) => finding.id));
  if (actualIds.size !== output.previousFindings.length) throw new Error('review contains duplicate previous finding ids');
  const missing = [...expectedIds].filter((id) => !actualIds.has(id));
  const extra = [...actualIds].filter((id) => !expectedIds.has(id));
  if (missing.length || extra.length) {
    throw new Error(`review finding dispositions mismatch; missing=[${missing}], extra=[${extra}]`);
  }

  const coercions = [];
  const previousFindings = output.previousFindings.map((disposition) => {
    if (!disposition.explanation.trim()) throw new Error(`${disposition.id} needs an explanation`);
    if (disposition.status === 'severity_changed') {
      if (!disposition.effectiveSeverity) throw new Error(`${disposition.id} severity_changed needs effectiveSeverity`);
      return disposition;
    }
    if (disposition.effectiveSeverity === null) return disposition;
    // Models often echo the current severity instead of null. Dropping the
    // echo is safe when the finding is closed or the value carries no new
    // information; only a genuine unrequested severity change stays an error.
    const closed = CLOSED.has(disposition.status);
    const current = before.get(disposition.id)?.effectiveSeverity ?? null;
    if (closed || disposition.effectiveSeverity === current) {
      coercions.push(`${disposition.id}: dropped redundant effectiveSeverity "${disposition.effectiveSeverity}" on status "${disposition.status}"`);
      return { ...disposition, effectiveSeverity: null };
    }
    throw new Error(`${disposition.id} sets effectiveSeverity "${disposition.effectiveSeverity}" without status severity_changed`);
  });
  return { previousFindings, coercions, required };
}

function checkNewFindingBody(finding) {
  if (!finding.noveltyRationale.trim() || !finding.problem.trim() || !finding.requiredChange.trim()) {
    throw new Error('new finding needs noveltyRationale, problem, and requiredChange');
  }
}

export function normalizeReviewerOutput(output, { round, priorReviews, overrides }) {
  const before = collectFindings(priorReviews, overrides);
  const { previousFindings, coercions, required } = normalizeDispositions(output, before);

  let next = nextFindingNumber(before);
  const knownIds = new Set(before.keys());
  const newFindings = output.newFindings.map((finding) => {
    if (finding.id !== null) throw new Error('provider-created new finding id must be null');
    if (finding.relatedToFindingId === null) {
      if (finding.relationKind !== null) throw new Error('new finding without relatedToFindingId must set relationKind null');
    } else {
      if (!knownIds.has(finding.relatedToFindingId)) {
        throw new Error(`new finding relates to unknown id ${finding.relatedToFindingId}`);
      }
      if (!RELATION_KINDS.has(finding.relationKind)) {
        throw new Error(`new finding related to ${finding.relatedToFindingId} needs relationKind "recurrence" or "adjacent"`);
      }
    }
    checkNewFindingBody(finding);
    const id = `F${String(next).padStart(3, '0')}`;
    next += 1;
    knownIds.add(id);
    return { ...finding, id };
  });

  const normalized = { ...output, previousFindings, newFindings };
  const synthetic = {
    meta: { round },
    review: normalized
  };
  const after = collectFindings([...priorReviews, synthetic], overrides);
  const expectedVerdict = blockingFindings(after).length ? 'changes_requested' : 'approved';
  if (normalized.verdict !== expectedVerdict) {
    throw new Error(`review verdict must be ${expectedVerdict}, received ${normalized.verdict}`);
  }
  return { normalized, findings: after, requiredBefore: required, coercions };
}

// Capture-time normalization for one reviewer slot. It never allocates finding
// ids — allocation is the merge's job (lib/merge.mjs), after the barrier, so
// two concurrent slots cannot both mint F00N. A same-output reference — today's
// accepted behavior, where a reviewer names its own earlier finding by the id
// today's allocator would have assigned it — is rewritten to a slot-local
// provisional id `P<k>` so the merge can never resolve it against a peer's
// allocation. The acceptance set is exactly normalizeReviewerOutput's:
// today's knownIds at index k is before ∪ {F(base)..F(base+k-1)}, which is the
// prior-round branch ∪ the position-predicted branch below, and the two are
// disjoint because base is one past the highest existing number.
export function normalizeSlotReview(output, { round, priorReviews, overrides }) {
  const before = collectFindings(priorReviews, overrides);
  const { previousFindings, coercions, required } = normalizeDispositions(output, before);

  const base = nextFindingNumber(before);
  const knownIds = new Set(before.keys());
  const predicted = new Map(output.newFindings.map((_, k) => [`F${String(base + k).padStart(3, '0')}`, k]));
  const newFindings = output.newFindings.map((finding, k) => {
    if (finding.id !== null) throw new Error('provider-created new finding id must be null');
    let relatedToFindingId = finding.relatedToFindingId;
    if (relatedToFindingId === null) {
      if (finding.relationKind !== null) throw new Error('new finding without relatedToFindingId must set relationKind null');
    } else {
      const selfIndex = predicted.get(relatedToFindingId);
      if (knownIds.has(relatedToFindingId)) {
        // A prior-round reference passes through verbatim, as today.
      } else if (selfIndex !== undefined && selfIndex < k) {
        relatedToFindingId = `P${selfIndex + 1}`;
      } else {
        // Forward references, out-of-range predictions, and junk alike:
        // today's rejection, today's message.
        throw new Error(`new finding relates to unknown id ${finding.relatedToFindingId}`);
      }
      if (!RELATION_KINDS.has(finding.relationKind)) {
        throw new Error(`new finding related to ${finding.relatedToFindingId} needs relationKind "recurrence" or "adjacent"`);
      }
    }
    checkNewFindingBody(finding);
    return { ...finding, id: null, relatedToFindingId };
  });

  // Verdict self-check over this slot's own view, with provisional ids. P-ids
  // are unique keys for the throwaway map and invisible to nextFindingNumber;
  // a slot-local reference is already the provisional id of the finding it
  // names, so a same-output recurrence inherits its ancestor's streak exactly
  // as today's computation does.
  const provisional = newFindings.map((finding, k) => ({ ...finding, id: `P${k + 1}` }));
  const synthetic = {
    meta: { round },
    review: { previousFindings, newFindings: provisional }
  };
  const after = collectFindings([...priorReviews, synthetic], overrides);
  const expectedVerdict = blockingFindings(after).length ? 'changes_requested' : 'approved';
  if (output.verdict !== expectedVerdict) {
    throw new Error(`review verdict must be ${expectedVerdict}, received ${output.verdict}`);
  }
  return { normalized: { ...output, previousFindings, newFindings }, requiredBefore: required, coercions };
}

export function validateOverrideInput({ findingId, disposition, severity, reason }, findings) {
  if (!findings.has(findingId)) throw new Error(`unknown finding ${findingId}`);
  if (!['withdrawn', 'severity_changed'].includes(disposition)) throw new Error('invalid override disposition');
  if (!String(reason || '').trim()) throw new Error('override reason is required');
  if (disposition === 'severity_changed' && !['blocker', 'major', 'minor', 'nit'].includes(severity)) {
    throw new Error('severity_changed override requires a valid severity');
  }
  if (disposition === 'withdrawn' && severity != null) throw new Error('withdrawn override must not set severity');
}

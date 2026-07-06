const CRITICAL = new Set(['blocker', 'major']);
const CLOSED = new Set(['resolved', 'withdrawn']);

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
      finding.closed = true;
      finding.criticalReviewStreak = 0;
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
    map.set(item.id, {
      ...item,
      introducedRound: round,
      lastReviewedRound: round,
      originalSeverity: item.severity,
      effectiveSeverity: item.severity,
      lastStatus: 'new',
      closed: false,
      criticalReviewStreak: 0,
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

export function requiredReviewerFindings(findings) {
  return [...findings.values()]
    .filter((finding) => !finding.closed && isCritical(finding.effectiveSeverity))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export function blockingFindings(findings) {
  return requiredReviewerFindings(findings);
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

export function validateAuthorResolutions(resolutions, requiredFindings) {
  const expected = new Set(requiredFindings.map((finding) => finding.id));
  const seen = new Set();
  for (const resolution of resolutions) {
    if (seen.has(resolution.findingId)) throw new Error(`duplicate resolution for ${resolution.findingId}`);
    seen.add(resolution.findingId);
    if (!resolution.explanation.trim()) throw new Error(`resolution ${resolution.findingId} needs an explanation`);
    if (resolution.action === 'superseded' && resolution.changedSections.length === 0) {
      throw new Error(`superseded resolution ${resolution.findingId} must name changed sections`);
    }
  }
  const missing = [...expected].filter((id) => !seen.has(id));
  if (missing.length) throw new Error(`author output is missing resolutions for ${missing.join(', ')}`);
}

export function normalizeReviewerOutput(output, { round, priorReviews, overrides }) {
  const before = collectFindings(priorReviews, overrides);
  const required = requiredReviewerFindings(before);
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

  let next = nextFindingNumber(before);
  const knownIds = new Set(before.keys());
  const newFindings = output.newFindings.map((finding) => {
    if (finding.id !== null) throw new Error('provider-created new finding id must be null');
    if (finding.relatedToFindingId !== null && !knownIds.has(finding.relatedToFindingId)) {
      throw new Error(`new finding relates to unknown id ${finding.relatedToFindingId}`);
    }
    if (!finding.noveltyRationale.trim() || !finding.problem.trim() || !finding.requiredChange.trim()) {
      throw new Error('new finding needs noveltyRationale, problem, and requiredChange');
    }
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

export function validateOverrideInput({ findingId, disposition, severity, reason }, findings) {
  if (!findings.has(findingId)) throw new Error(`unknown finding ${findingId}`);
  if (!['withdrawn', 'severity_changed'].includes(disposition)) throw new Error('invalid override disposition');
  if (!String(reason || '').trim()) throw new Error('override reason is required');
  if (disposition === 'severity_changed' && !['blocker', 'major', 'minor', 'nit'].includes(severity)) {
    throw new Error('severity_changed override requires a valid severity');
  }
  if (disposition === 'withdrawn' && severity != null) throw new Error('withdrawn override must not set severity');
}

// Pure CLI-roster construction: no I/O, importable by tests without touching
// cli.mjs (whose import-time main() call makes it untestable directly — and an
// entrypoint guard comparing argv[1] to import.meta.url breaks under npm's
// .bin symlinks, so the logic lives here instead).
const PROVIDERS = ['claude', 'codex'];
const SLOT_FLAGS = new Set(['reviewer-model', 'reviewer-effort', 'claude-reviewer-max-budget-usd']);

function budgetValue(raw, key) {
  if (raw == null) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`--${key} must be a positive number`);
  return parsed;
}

// The binding rule, stated once for all three cases: fewer than two --reviewer
// occurrences → exactly one slot, every slot-scoped flag binds to it from
// `values` regardless of order (today's behavior, byte-for-byte — including the
// zero-occurrence default of one codex slot). Two or more → binding is
// positional: each slot-scoped flag binds to the most recent preceding
// --reviewer, read from `tokens`.
export function reviewerRosterFromArgs({ author, tokens, values }) {
  const occurrences = tokens.filter(([key]) => key === 'reviewer').length;
  let slots;
  if (occurrences < 2) {
    slots = [{
      provider: values.reviewer || 'codex',
      model: values['reviewer-model'] || null,
      effort: values['reviewer-effort'] || null,
      claudeMaxBudgetUsd: budgetValue(values['claude-reviewer-max-budget-usd'], 'claude-reviewer-max-budget-usd')
    }];
  } else {
    slots = [];
    let current = null;
    for (const [key, value] of tokens) {
      if (key === 'reviewer') {
        current = { provider: value, model: null, effort: null, claudeMaxBudgetUsd: null };
        slots.push(current);
        continue;
      }
      if (!SLOT_FLAGS.has(key)) continue;
      if (!current) {
        throw new Error(`--${key} must follow the --reviewer it configures when several reviewers are given`);
      }
      if (key === 'reviewer-model') current.model = value;
      else if (key === 'reviewer-effort') current.effort = value;
      else current.claudeMaxBudgetUsd = budgetValue(value, key);
    }
  }
  for (const slot of slots) {
    if (!PROVIDERS.includes(slot.provider)) {
      throw new Error('--author and --reviewer must be claude or codex');
    }
  }
  // The flag guards author-vs-reviewer only. Two reviewer slots sharing a
  // provider — or a model — need no flag: that is a deliberate configuration
  // (sampling-variance probes are legitimate).
  if (slots.some((slot) => slot.provider === author) && !values['allow-same-provider']) {
    throw new Error('author and reviewer must differ unless --allow-same-provider is set');
  }
  return slots;
}

import fsp from 'node:fs/promises';
import path from 'node:path';
import {
  assertInside,
  atomicWriteFile,
  atomicWriteJson,
  fileSha256,
  gitSnapshot,
  jsonText,
  listRounds,
  readFailures,
  readJson,
  readJsonIfExists,
  readTextIfExists,
  recordFailure,
  recordFailureClearance,
  roundPaths,
  sha256,
  taskPaths
} from './artifacts.mjs';
import {
  activeFindings,
  blockingFindings,
  closedFindings,
  collectFindings,
  coveredIds,
  hasStalledCriticalFinding,
  normalizeSlotReview,
  validateAuthorResolutions,
  validateOverrideInput
} from './findings.mjs';
import { mergeRoundReviews } from './merge.mjs';
import { buildAuthorPrompt, buildReviewerPrompt } from './prompts.mjs';
import { NOOP_LOGGER } from './logger.mjs';
import { ProviderError } from './process.mjs';
import { validatePlanMarkdown, validationError } from './schema.mjs';

const DEFAULT_OVERRIDES = { schemaVersion: 1, entries: [] };

// Effort enums differ per provider CLI: codex validates at the OpenAI API
// (reasoning.effort), claude validates --effort locally.
const PROVIDER_EFFORTS = {
  claude: { valid: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'xhigh' },
  codex: { valid: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'], default: 'high' }
};

// Model selection, in precedence order: an explicit --author-model /
// --reviewer-model, then the provider's env var, then the CLI's own built-in
// default.
//
// There is deliberately no hard-coded default model here. Unlike effort — whose
// values are universal — an available model depends on the account behind the
// provider CLI, so naming one would break every user who lacks it, and the
// failure would surface as an opaque 400 from a subprocess.
//
// The env var matters more than it looks for codex. The adapter passes
// `--ignore-user-config` (deliberately: reviews must not silently depend on
// whatever is in `~/.codex/config.toml`), which means a `model = "..."` set
// there is NOT honoured. Without an explicit model, codex falls back to its own
// built-in default, which is a small, fast model — a poor reviewer, and easy to
// mistake for a strict one that simply found nothing. Set the env var to hold a
// model choice across runs.
const PROVIDER_MODELS = {
  claude: { env: 'PLAN_FORGE_CLAUDE_MODEL' },
  codex: { env: 'PLAN_FORGE_CODEX_MODEL' }
};

export const DEFAULT_PUBLISH_DIR = 'docs/plans';

// A slot is one reviewer configuration, identified by 1-based position — not by
// provider, since two slots may share one (the requirement's own evidence
// compares two codex models). Normalizes both storage forms: the roster every
// new task writes, and the singular keys every task on disk today has.
export function reviewerSlots(task) {
  if (Array.isArray(task.reviewers) && task.reviewers.length) {
    return task.reviewers.map((slot, index) => ({
      id: `R${index + 1}`,
      index: index + 1,
      provider: slot.provider,
      model: slot.model ?? null,
      effort: slot.effort ?? null,
      claudeMaxBudgetUsd: slot.claudeMaxBudgetUsd ?? null
    }));
  }
  return [{
    id: 'R1',
    index: 1,
    provider: task.reviewer,
    model: task.reviewerModel ?? null,
    effort: task.reviewerEffort ?? null,
    claudeMaxBudgetUsd: task.claudeReviewerMaxBudgetUsd ?? null
  }];
}

// The one expression both published headers use for `reviewer=`. Interpolating
// task.reviewer directly is undefined for any roster task; at N=1 this returns
// today's value byte-for-byte.
export function reviewerLabel(task) {
  return reviewerSlots(task).map((slot) => slot.provider).join(',');
}

// author-output.json stores exactly what the provider returned; every reader
// normalizes in memory before validating. The [] default means "this
// resolution covers only its own findingId" — today's semantics — so legacy
// outputs on disk and providers that ignore the field both keep working.
export function normalizeAuthorOutput(output) {
  return {
    ...output,
    resolutions: (output.resolutions ?? []).map((resolution) => ({
      ...resolution,
      coversFindingIds: resolution.coversFindingIds ?? []
    }))
  };
}

function publishedPathFor(paths, task) {
  const dir = task.publishDir ?? DEFAULT_PUBLISH_DIR;
  return assertInside(paths.repoRoot, path.resolve(paths.repoRoot, dir, `${task.taskId}.md`));
}

// A deliberately stopped plan is published beside the approved ones but never
// among them: it is the artifact a human has to adjudicate, and leaving it in
// the gitignored runtime dir strands the decision on one machine.
function needsHumanPathFor(paths, task) {
  const dir = task.publishDir ?? DEFAULT_PUBLISH_DIR;
  return assertInside(paths.repoRoot, path.resolve(paths.repoRoot, dir, 'needs_human', `${task.taskId}.md`));
}

// Self-contained archive: with an inline requirement there may be no requirement
// file outside the gitignored runtime dir, so the frozen text ships as an
// appendix. `status` is the discriminator — never infer approval from the path.
function publishedDocument(header, planMarkdown, requirementMarkdown) {
  return `<!-- plan-forge: ${header} -->\n\n`
    + planMarkdown.replace(/\n$/, '')
    + `\n\n---\n\n## Appendix: Frozen Requirement\n\n${requirementMarkdown}`;
}

async function writeIfChanged(file, content) {
  if (await readTextIfExists(file) !== content) {
    await atomicWriteFile(file, content, { mode: 0o644 });
    return true;
  }
  return false;
}

function bullets(lines) {
  return lines.length ? lines.map((line) => `- ${line}`).join('\n') : '- (none recorded)';
}

// The decision brief. A stopped plan is useless to a human without the argument
// that stopped it, and an 850-line plan buries it — so both sides' positions go
// above the plan, not in the runtime dir the human cannot see.
function decisionBrief({ task, review, blocking, resolutions, stoppedBecause }) {
  const sections = blocking.map((finding) => {
    // A covered finding's answer lives on another resolution; without the
    // coveredIds lookup the brief would tell the human the author never
    // answered it, which is false.
    const authorSide = resolutions.find((item) => coveredIds(item).includes(finding.id));
    return [
      `## ${finding.id} — ${finding.effectiveSeverity} · ${finding.planSection} (raised by ${finding.raisedBy ?? 'R1'})`,
      '',
      `**Problem**\n\n${finding.problem}`,
      '',
      `**Required change**\n\n${finding.requiredChange}`,
      '',
      `**Evidence**\n\n${bullets(finding.evidence ?? [])}`,
      '',
      `**Reviewer's position** (last reviewed round ${finding.lastReviewedRound}, status \`${finding.lastStatus}\`)\n\n`
        + `${finding.lastExplanation ?? '(raised this round; see Problem above)'}`,
      '',
      `**Author's position**\n\n`
        + (authorSide
          ? `\`${authorSide.action}\` — ${authorSide.explanation}`
          : '(the author never answered this finding)')
    ].join('\n');
  });

  return [
    `# Decision required — ${task.taskId}`,
    '',
    `This plan **did not pass the gate**. It stopped at round ${review.meta.round} because ${stoppedBecause}.`,
    `Nothing below is approved. ${blocking.length} finding(s) block it: ${blocking.map((f) => f.id).join(', ')}.`,
    '',
    ...sections,
    '',
    '## Your options',
    '',
    'Only a human decides these. Each override is recorded with your reason and is auditable.',
    '',
    '1. **The reviewer is wrong** — you accept the author\'s counter-evidence:',
    '   ```',
    `   plan-forge override --task ${task.taskId} --finding <ID> --disposition withdrawn --reason "<why>"`,
    '   ```',
    '2. **Real, but not blocking** — downgrade it; it stays open and on the record:',
    '   ```',
    `   plan-forge override --task ${task.taskId} --finding <ID> --disposition severity_changed --severity minor --reason "<why>"`,
    '   ```',
    `   Then \`plan-forge resume --task ${task.taskId}\`.`,
    '',
    'A ruling settles a **finding**; it is not an approval and does not end the review. Once your rulings leave no',
    'blocker, the author revises with them visible and the reviewer re-reviews — only a reviewer verdict of',
    '`approved` finalizes the plan. Rule on some but not all of the blockers and the task stays stopped, so decide',
    'every one below before you resume.',
    '',
    '3. **Neither fits** — if the finding exposes a conflict in the *frozen requirement itself*, no override can',
    '   express the fix. Requirements are immutable by design: amend the requirement and start a **new task id**.',
    '   Deciding the design here and overriding the finding would approve a plan that still contains the defect.'
  ].join('\n');
}

async function publishForHuman(context, review, logger) {
  const author = context.authorOutputs.get(review.meta.round);
  if (!author) return;
  const blocking = blockingFindings(context.findings);
  const stoppedBecause = review.meta.round >= context.task.maxRounds
    ? `the round limit (${context.task.maxRounds}) was reached with blocking findings still open`
    : 'a blocking finding survived two consecutive re-reviews';
  // stoppedAt tracks the verdict, not the moment of writing, so a re-run that
  // re-stalls rewrites nothing and the file does not churn in git.
  const header = `task=${context.task.taskId} round=${review.meta.round} author=${context.task.author}`
    + ` reviewer=${reviewerLabel(context.task)} status=needs_human stoppedAt=${review.meta.completedAt}`
    + ` blockingFindingIds=${blocking.map((finding) => finding.id).join(',')}`
    + ` planSha256=${sha256(author.plan)} requirementSha256=${context.task.requirementSha256}`;
  const brief = decisionBrief({ task: context.task, review, blocking, resolutions: author.resolutions, stoppedBecause });
  const file = needsHumanPathFor(context.paths, context.task);
  await writeIfChanged(file, publishedDocument(header, `${brief}\n\n---\n\n${author.plan}`, context.task.requirementMarkdown));
  logger.stage('plan published for human decision', { phase: 'reviewing', round: review.meta.round, file });
}

export function resolveEffort(provider, effort = null) {
  const spec = PROVIDER_EFFORTS[provider];
  if (!spec) throw new Error(`unsupported provider ${provider}`);
  const value = effort ?? spec.default;
  if (!spec.valid.includes(value)) {
    throw new Error(`invalid effort "${value}" for ${provider}; valid values: ${spec.valid.join(', ')}`);
  }
  return value;
}

/// Resolve the model for a provider: explicit flag, then env var, then null
/// (the provider CLI's built-in default). Values are not validated here — only
/// the provider CLI knows which models the current account can reach.
export function resolveModel(provider, model = null, env = process.env) {
  const spec = PROVIDER_MODELS[provider];
  if (!spec) throw new Error(`unsupported provider ${provider}`);
  const value = model ?? env[spec.env] ?? null;
  return value && String(value).trim() ? String(value).trim() : null;
}

function now() {
  return new Date().toISOString();
}

function normalizedErrorClass(error) {
  if (error instanceof ProviderError) {
    if (error.incomplete) return 'incomplete_output';
    if (error.retryable) return 'transient_provider_error';
    return 'provider_error';
  }
  if (/schema validation|incomplete/i.test(error.message)) return 'invalid_output';
  return 'workflow_error';
}

function wrapperMeta({ providerMeta, role, round, prompt, startedAt, repoRoot, extra = {} }) {
  const git = gitSnapshot(repoRoot);
  return {
    schemaVersion: 1,
    role,
    round,
    provider: providerMeta.provider,
    model: providerMeta.model ?? null,
    cliVersion: providerMeta.cliVersion ?? null,
    promptSha256: sha256(prompt),
    effort: providerMeta.effort ?? null,
    startedAt,
    completedAt: now(),
    usage: providerMeta.usage ?? null,
    costUsd: providerMeta.costUsd ?? null,
    sessionId: providerMeta.sessionId ?? null,
    gitHead: git.head,
    gitDirty: git.dirty,
    ...extra
  };
}

async function invokeWithLimit({ role, phase, round, provider, prompt, schema, schemaFile, timeoutMs, validate, logger, slot = null }) {
  // The slot rides in the log fields, never in the stderr prefix — the
  // documented `codex:stderr` / `claude:stderr` prefix stays untouched.
  const fields = slot === null ? {} : { slot };
  let lastError;
  let attemptCount = 0;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    attemptCount = attempt;
    const attemptStartedAt = Date.now();
    logger.stage('provider attempt started', { phase, round, provider: provider.name, attempt, ...fields });
    let result = null;
    try {
      result = await provider.invoke({
        prompt,
        schema,
        schemaFile,
        timeoutMs,
        onStderr: (chunk) => logger.providerStderr(provider.name, chunk, { phase, round, attempt, ...fields }),
        onHeartbeat: ({ elapsedMs, pid }) => logger.heartbeat('provider still running', {
          phase,
          round,
          provider: provider.name,
          attempt,
          elapsedSeconds: Math.floor(elapsedMs / 1000),
          pid,
          ...fields
        }),
        onSuspend: ({ suspendedMs }) => logger.stage('system suspension detected; provider deadline extended', {
          phase,
          round,
          provider: provider.name,
          attempt,
          suspendedSeconds: Math.floor(suspendedMs / 1000),
          ...fields
        })
      });
      validate(result.data);
      logger.stage('provider attempt completed', {
        phase,
        round,
        provider: provider.name,
        attempt,
        elapsedSeconds: Math.floor((Date.now() - attemptStartedAt) / 1000),
        ...fields
      });
      return { ...result, attempts: attempt };
    } catch (error) {
      lastError = error;
      if (result && error.rawOutput === undefined) error.rawOutput = result.data;
      const authorOutputRetry = role === 'author' && (error.incomplete || /schema validation|plan Markdown is incomplete/i.test(error.message));
      const mayRetry = attempt === 1 && (error.retryable || authorOutputRetry);
      logger.error(mayRetry ? 'provider attempt failed; retrying' : 'provider attempt failed', {
        phase,
        round,
        provider: provider.name,
        attempt,
        errorClass: normalizedErrorClass(error),
        ...fields
      });
      if (!mayRetry) break;
    }
  }
  lastError.attempts = attemptCount;
  throw lastError;
}

async function ensureTaskProjection(paths, task, repair) {
  const expected = `${task.requirementMarkdown.trim()}\n`;
  const actual = await readTextIfExists(paths.requirement);
  if (actual !== expected && repair) await atomicWriteFile(paths.requirement, expected);
  return expected;
}

async function listSlotCaptures(files) {
  try {
    const entries = await fsp.readdir(files.reviewsDir);
    return entries.filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5)).sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

// Post-merge: the round's own meta.reviewers is the authority, and the check is
// frozen-input-vs-frozen-input — capture bytes against the hash the merge
// recorded, the slot set against a roster fixed at task creation. Nothing here
// consults the overrides document, so no later human ruling can make a
// committed round fail to load.
async function verifyMergedCaptures(files, review, roster) {
  const entries = review.meta.reviewers;
  const seen = new Set();
  for (const entry of entries) {
    if (seen.has(entry.slot)) throw new Error(`round ${files.name} review lists reviewer slot ${entry.slot} twice`);
    seen.add(entry.slot);
  }
  const rosterIds = roster.map((slot) => slot.id);
  if (rosterIds.length !== entries.length || !rosterIds.every((id) => seen.has(id))) {
    throw new Error(`round ${files.name} merged under slots ${entries.map((entry) => entry.slot).join(', ')} `
      + `but the task roster is ${rosterIds.join(', ')}`);
  }
  for (const entry of entries) {
    const content = await readTextIfExists(files.slotReview(entry.slot));
    if (content === null) throw new Error(`round ${files.name} is missing the committed review for slot ${entry.slot}`);
    if (sha256(content) !== entry.captureSha256) {
      throw new Error(`round ${files.name} review for slot ${entry.slot} does not match the sha256 recorded when the round merged`);
    }
  }
  for (const slotId of await listSlotCaptures(files)) {
    if (!seen.has(slotId)) throw new Error(`round ${files.name} has a review for unknown reviewer slot ${slotId}`);
  }
}

// Pre-merge: nothing authoritative exists yet, so a capture is checked against
// the current roster, plan, and schema — including that the configured juror
// produced it. Config disagreement is a hard error, not a supersession: the
// roster is frozen, so a mismatch is tampering or a composition bug, and the
// repair is deleting the offending capture (the slot re-runs). The model check
// runs only where the slot pins one, which is what keeps N=1's late binding.
async function readSlotReviews(files, roster, plan, schemas) {
  const captures = new Map();
  const rosterById = new Map(roster.map((slot) => [slot.id, slot]));
  for (const slotId of await listSlotCaptures(files)) {
    const slot = rosterById.get(slotId);
    if (!slot) throw new Error(`round ${files.name} has a review for unknown reviewer slot ${slotId}`);
    const content = await fsp.readFile(files.slotReview(slotId), 'utf8');
    const wrapper = JSON.parse(content);
    if (!schemas.validateReviewer(wrapper.review)) {
      throw validationError(`round ${files.name} slot ${slotId} review`, schemas.validateReviewer);
    }
    if (wrapper.meta?.round !== files.round) throw new Error(`round ${files.name} review for slot ${slotId} metadata has wrong round`);
    if (wrapper.meta.slot !== slotId) throw new Error(`round ${files.name} review for slot ${slotId} carries slot ${wrapper.meta.slot}`);
    if (wrapper.meta.planSha256 !== sha256(plan)) throw new Error(`round ${files.name} review for slot ${slotId} is bound to a different plan`);
    if (wrapper.meta.provider !== slot.provider) {
      throw new Error(`round ${files.name} review for slot ${slotId} was produced by ${wrapper.meta.provider}, `
        + `but the slot is configured for ${slot.provider}`);
    }
    if (slot.model && wrapper.meta.model !== slot.model) {
      throw new Error(`round ${files.name} review for slot ${slotId} records model ${wrapper.meta.model}, `
        + `but the slot is pinned to ${slot.model}`);
    }
    captures.set(slotId, { wrapper, fileSha256: sha256(content) });
  }
  return captures;
}

async function loadRoundArtifacts({ paths, schemas, repair, roster }) {
  const rounds = await listRounds(paths.taskDir);
  for (let index = 0; index < rounds.length; index += 1) {
    if (rounds[index] !== index + 1) throw new Error('round directories must be contiguous and start at 001');
  }
  const authorOutputs = new Map();
  const reviews = [];
  const slotReviews = new Map();

  for (const round of rounds) {
    const files = roundPaths(paths.taskDir, round);
    const author = await readJsonIfExists(files.authorOutput);
    if (!author) {
      const orphanPlan = await readTextIfExists(files.plan);
      const orphanResolution = await readTextIfExists(files.resolution);
      if (orphanPlan !== null || orphanResolution !== null) {
        throw new Error(`round ${files.name} has projections without author-output.json`);
      }
      continue;
    }
    const normalizedAuthor = normalizeAuthorOutput(author.output);
    if (!schemas.validateAuthor(normalizedAuthor)) throw validationError(`round ${files.name} author output`, schemas.validateAuthor);
    if (author.meta?.round !== round || author.meta?.role !== 'author') {
      throw new Error(`round ${files.name} author metadata is invalid`);
    }
    const plan = validatePlanMarkdown(author.output.planMarkdown);
    // Projections and hashes come from the stored bytes; normalization is
    // in-memory only, so repair never rewrites a committed round's projection.
    const resolutionText = jsonText(author.output.resolutions);
    const actualPlan = await readTextIfExists(files.plan);
    const actualResolution = await readTextIfExists(files.resolution);
    if (repair && actualPlan !== plan) await atomicWriteFile(files.plan, plan);
    if (repair && actualResolution !== resolutionText) await atomicWriteFile(files.resolution, resolutionText);
    authorOutputs.set(round, {
      wrapper: author,
      plan,
      resolutions: normalizedAuthor.resolutions,
      storedResolutions: author.output.resolutions,
      files
    });

    const review = await readJsonIfExists(files.review);
    if (review) {
      // The round declares its format; it is never inferred. Absence-as-signal
      // would make the weaker branch the default — a merged round that lost a
      // field would silently skip every capture check below.
      const version = review.meta?.schemaVersion;
      if (version === 2) {
        if (!schemas.validateMergedReview(review)) throw validationError(`round ${files.name} review`, schemas.validateMergedReview);
      } else if (version === 1) {
        // Provenance before schema: a v1 claim carrying meta.reviewers is a
        // contradiction worth naming precisely, not a generic schema failure.
        if (review.meta.reviewers !== undefined) {
          throw new Error(`round ${files.name} review declares schemaVersion 1 but carries merge provenance`);
        }
        if (!schemas.validateReviewer(review.review)) throw validationError(`round ${files.name} review`, schemas.validateReviewer);
      } else {
        throw new Error(`round ${files.name} review has unsupported schemaVersion ${JSON.stringify(version)}`);
      }
      if (review.meta.round !== round) throw new Error(`round ${files.name} review metadata has wrong round`);
      if (review.meta.planSha256 !== sha256(plan)) throw new Error(`round ${files.name} review is bound to a different plan`);
      if (version === 2) await verifyMergedCaptures(files, review, roster);
      reviews.push(review);
    } else {
      slotReviews.set(round, await readSlotReviews(files, roster, plan, schemas));
    }
  }
  return { rounds, authorOutputs, reviews, slotReviews };
}

// Exactly one storage form may be present — the roster new tasks write, or the
// singular keys legacy tasks carry — and every slot's provider must be real.
// Model resolution is deliberately NOT checked here: loadContext also serves
// read-only commands like status, and a task must stay inspectable regardless
// of what the current environment exports.
function validReviewerConfiguration(task) {
  const rosterForm = Array.isArray(task.reviewers);
  const singularForm = task.reviewer !== undefined;
  if (rosterForm === singularForm) return false;
  const slots = rosterForm ? task.reviewers : [{ provider: task.reviewer }];
  return slots.length >= 1 && slots.every((slot) => ['claude', 'codex'].includes(slot?.provider));
}

async function loadContext({ repoRoot, taskId, schemas, repair = false }) {
  const paths = taskPaths(repoRoot, taskId);
  const task = await readJson(paths.task);
  if (!validReviewerConfiguration(task)) {
    throw new Error('task.json reviewer configuration is invalid');
  }
  if (
    task.schemaVersion !== 1 ||
    task.taskId !== taskId ||
    !['claude', 'codex'].includes(task.author) ||
    !Number.isInteger(task.maxRounds) || task.maxRounds < 1 ||
    !Number.isInteger(task.maxProviderFailures) || task.maxProviderFailures < 1 ||
    sha256(`${task.requirementMarkdown.trim()}\n`) !== task.requirementSha256
  ) {
    throw new Error('task.json requirement identity is invalid');
  }
  const requirement = await ensureTaskProjection(paths, task, repair);
  const overrides = (await readJsonIfExists(paths.overrides)) ?? DEFAULT_OVERRIDES;
  const artifacts = await loadRoundArtifacts({ paths, schemas, repair, roster: reviewerSlots(task) });
  const findings = collectFindings(artifacts.reviews, overrides);
  const approval = await readJsonIfExists(paths.approval);
  const context = { paths, task, requirement, overrides, findings, approval, ...artifacts };
  if (approval) await validateApproval(context);
  return context;
}

function lastReview(context) {
  return context.reviews.at(-1) ?? null;
}

function lastAuthor(context) {
  const rounds = [...context.authorOutputs.keys()].sort((a, b) => a - b);
  return rounds.length ? context.authorOutputs.get(rounds.at(-1)) : null;
}

async function writeState(context, { status, phase, round, errorClass = null }) {
  const state = {
    schemaVersion: 1,
    taskId: context.task.taskId,
    status,
    phase,
    round,
    requirementSha256: context.task.requirementSha256,
    blockingFindingIds: blockingFindings(context.findings).map((finding) => finding.id),
    errorClass,
    updatedAt: now()
  };
  await atomicWriteJson(context.paths.state, state);
  return state;
}

function phaseKeyOf(phase, round) {
  return `${phase}:${String(round).padStart(3, '0')}`;
}

// The phaseKey stays `reviewing:003` — slot-scoping the key would orphan every
// existing task's failure records, silently handing a nearly-latched task a
// fresh budget. Legacy records carry no slot and normalize to R1 at read time,
// so N=1 counts are preserved exactly. Author phases pass slot = null.
async function failureCount(paths, phaseKey, slot = null) {
  const entries = await readFailures(paths);
  const lastClearance = entries
    .filter((entry) => entry.kind === 'clearance')
    .reduce((max, entry) => Math.max(max, entry.sequence), 0);
  return entries.filter(
    (entry) => entry.kind !== 'clearance' && entry.phaseKey === phaseKey && entry.sequence > lastClearance
      && (slot === null || (entry.slot ?? 'R1') === slot)
  ).length;
}

async function failureStatus(context, phaseKey, slot = null) {
  const count = await failureCount(context.paths, phaseKey, slot);
  if (count >= context.task.maxProviderFailures) return { status: 'needs_human', count };
  if (count > 0) return { status: 'failed', count };
  return { status: 'running', count: 0 };
}

async function handlePhaseFailure(context, { round, phase, provider, error, logger }) {
  const phaseKey = phaseKeyOf(phase, round);
  await recordFailure(context.paths, {
    round,
    phase,
    phaseKey,
    provider,
    errorClass: normalizedErrorClass(error),
    attempts: error.attempts ?? 1,
    message: String(error.message || '').slice(0, 500),
    rejectedOutput: error.rawOutput ?? null
  });
  const count = await failureCount(context.paths, phaseKey);
  const status = count >= context.task.maxProviderFailures ? 'needs_human' : 'failed';
  logger.error('phase failed', { phase, round, provider, status, consecutiveFailures: count });
  await writeState(context, { status, phase, round, errorClass: normalizedErrorClass(error) });
  if (status === 'needs_human') return { status, phase, round, errorClass: normalizedErrorClass(error) };
  throw error;
}

// N-ary generalization of handlePhaseFailure for the fan-out. Each slot's
// budget is its own — the failures are independent events from independent
// subprocesses — so R2 latching needs_human never spends R1's budget. At N=1
// this reduces to handlePhaseFailure exactly: one record, one count, the same
// state write, the original error rethrown.
async function handleReviewFailures(context, { round, failures, logger }) {
  const phaseKey = phaseKeyOf('reviewing', round);
  const latched = [];
  for (const { slot, error } of failures) {
    await recordFailure(context.paths, {
      round,
      phase: 'reviewing',
      phaseKey,
      provider: slot.provider,
      slot: slot.id,
      errorClass: normalizedErrorClass(error),
      attempts: error.attempts ?? 1,
      message: String(error.message || '').slice(0, 500),
      rejectedOutput: error.rawOutput ?? null
    });
    const count = await failureCount(context.paths, phaseKey, slot.id);
    if (count >= context.task.maxProviderFailures) latched.push(slot.id);
    logger.error('phase failed', {
      phase: 'reviewing',
      round,
      provider: slot.provider,
      slot: slot.id,
      status: count >= context.task.maxProviderFailures ? 'needs_human' : 'failed',
      consecutiveFailures: count
    });
  }
  const status = latched.length ? 'needs_human' : 'failed';
  // errorClass names the latching slot's failure when one latched; the
  // roster-first failure otherwise.
  const primary = latched.length
    ? failures.find(({ slot }) => latched.includes(slot.id))
    : failures[0];
  await writeState(context, { status, phase: 'reviewing', round, errorClass: normalizedErrorClass(primary.error) });
  if (status === 'needs_human') {
    return { status, phase: 'reviewing', round, errorClass: normalizedErrorClass(primary.error) };
  }
  throw failures.length === 1
    ? failures[0].error
    : new Error(`reviewer slots ${failures.map(({ slot }) => slot.id).join(', ')} failed: ${failures[0].error.message}`);
}

// Position is slot identity, so a positional adapter array is the right shape —
// but only if it actually lines up. runWorkflow takes providers from its
// caller (tests hand-build it), and a mis-ordered array would spend real money
// recording the wrong juror. Runs after every loadContext: idempotent, free
// over in-memory data, and no resume path can skip it.
function assertReviewerAdapters(roster, adapters) {
  if (!Array.isArray(adapters) || adapters.length !== roster.length) {
    throw new Error(`${Array.isArray(adapters) ? adapters.length : 0} reviewer adapters were supplied `
      + `for a ${roster.length}-slot roster`);
  }
  for (const slot of roster) {
    const adapter = adapters[slot.index - 1];
    if (adapter.name !== slot.provider) {
      throw new Error(`reviewer slot ${slot.id} is configured for ${slot.provider} `
        + `but the runtime supplied a ${adapter.name} adapter`);
    }
  }
}

async function writeManifest(context, round, logger = NOOP_LOGGER) {
  const files = roundPaths(context.paths.taskDir, round);
  const author = context.authorOutputs.get(round);
  const review = context.reviews.find((item) => item.meta.round === round);
  if (!author || !review) return;
  if (await readTextIfExists(files.manifest) !== null) return;
  // resolutionSha256 hashes the stored bytes, so a manifest backfilled onto a
  // legacy round agrees with what is actually on disk. A v2 round's manifest
  // carries the per-slot audit (reviewers, capture hashes included) in place of
  // the flat reviewerMeta; a v1 backfill keeps the flat shape its round has.
  const reviewerAudit = review.meta.schemaVersion === 2
    ? { reviewers: review.meta.reviewers }
    : { reviewerMeta: review.meta };
  await atomicWriteJson(files.manifest, {
    schemaVersion: 1,
    round,
    authorOutputSha256: await fileSha256(files.authorOutput),
    planSha256: sha256(author.plan),
    resolutionSha256: sha256(jsonText(author.storedResolutions)),
    reviewSha256: await fileSha256(files.review),
    authorMeta: author.wrapper.meta,
    ...reviewerAudit,
    completedAt: now()
  });
  logger.stage('round manifest committed', { phase: 'reviewing', round, file: files.manifest });
}

async function expectedApprovalFields(context) {
  const review = lastReview(context);
  const author = review ? context.authorOutputs.get(review.meta.round) : null;
  if (!review || !author) throw new Error('approval exists without a complete reviewed round');
  return {
    taskId: context.task.taskId,
    round: review.meta.round,
    requirementSha256: context.task.requirementSha256,
    authorOutputSha256: await fileSha256(author.files.authorOutput),
    planSha256: sha256(author.plan),
    reviewSha256: await fileSha256(author.files.review),
    overridesSha256: sha256(jsonText(context.overrides))
  };
}

async function validateApproval(context) {
  const expected = await expectedApprovalFields(context);
  for (const [key, value] of Object.entries(expected)) {
    if (context.approval[key] !== value) throw new Error(`approval.json has an invalid ${key}`);
  }
}

async function finalize(context, logger = NOOP_LOGGER) {
  const review = lastReview(context);
  const author = context.authorOutputs.get(review.meta.round);
  const publishedFile = publishedPathFor(context.paths, context.task);
  if (!author || blockingFindings(context.findings).length) throw new Error('cannot finalize with blocking findings');
  let approval = context.approval;
  if (!approval) {
    const overrideText = jsonText(context.overrides);
    approval = {
      schemaVersion: 1,
      taskId: context.task.taskId,
      round: review.meta.round,
      requirementSha256: context.task.requirementSha256,
      authorOutputSha256: await fileSha256(author.files.authorOutput),
      planSha256: sha256(author.plan),
      reviewSha256: await fileSha256(author.files.review),
      overridesSha256: sha256(overrideText),
      gate: {
        verdict: 'approved',
        blockingFindingIds: [],
        overrides: context.overrides.entries
      },
      publishedPath: path.relative(context.paths.repoRoot, publishedFile),
      approvedAt: now()
    };
    await atomicWriteJson(context.paths.approval, approval);
    logger.stage('approval committed', { phase: 'finalizing', round: review.meta.round, file: context.paths.approval });
  }
  const expectedApproval = await expectedApprovalFields(context);
  for (const [key, value] of Object.entries(expectedApproval)) {
    if (approval[key] !== value) throw new Error(`approval.json has an invalid ${key}`);
  }
  const currentFinal = await readTextIfExists(context.paths.final);
  if (currentFinal !== author.plan) await atomicWriteFile(context.paths.final, author.plan);
  logger.stage('final plan ready', { phase: 'finalizing', round: review.meta.round, file: context.paths.final });
  // Approved plans are archived into version control automatically.
  const header = `task=${context.task.taskId} round=${approval.round} author=${context.task.author} reviewer=${reviewerLabel(context.task)} status=approved approvedAt=${approval.approvedAt} planSha256=${approval.planSha256} requirementSha256=${context.task.requirementSha256}`;
  await writeIfChanged(publishedFile, publishedDocument(header, author.plan, context.task.requirementMarkdown));
  logger.stage('final plan published', { phase: 'finalizing', round: review.meta.round, file: publishedFile });
  // A pending copy from an earlier deliberate stop is now false: this plan
  // passed the gate. Two contradictory published plans is worse than none.
  const pendingFile = needsHumanPathFor(context.paths, context.task);
  await fsp.rm(pendingFile, { force: true });
  context.approval = approval;
  return writeState(context, { status: 'approved', phase: 'finalizing', round: review.meta.round });
}

// N>1 pins every slot's model at creation: the audit record must name every
// juror, and the codex adapter records meta.model from the configured value, so
// a slot resolving to null would persist an unknowable "whatever the CLI
// defaulted to that day". An env-provided model is a valid pin; what is
// rejected is a slot that resolves to nothing.
function pinnedReviewerModel(slot, index) {
  const model = resolveModel(slot.provider, slot.model ?? null);
  if (model) return model;
  throw new Error(`reviewer slot R${index + 1} (${slot.provider}) has no model; a multi-reviewer roster `
    + `must pin every slot with --reviewer-model or ${PROVIDER_MODELS[slot.provider].env}`);
}

export async function initializeTask({ repoRoot, taskId, requirementFile = null, requirementText = null, options }) {
  const paths = taskPaths(repoRoot, taskId);
  if (await readJsonIfExists(paths.task)) throw new Error(`task ${taskId} already exists; use resume`);
  if ((requirementFile === null) === (requirementText === null)) {
    throw new Error('provide exactly one of requirementFile or requirementText');
  }
  const source = requirementText ?? await fsp.readFile(requirementFile, 'utf8');
  const requirement = `${String(source).trim()}\n`;
  if (!requirement.trim()) throw new Error('requirement is empty');
  const publishDir = options.publishDir ?? DEFAULT_PUBLISH_DIR;
  assertInside(repoRoot, path.resolve(repoRoot, publishDir));
  if (!options.reviewers?.length) throw new Error('a task needs at least one reviewer slot');
  const multi = options.reviewers.length > 1;
  // N=1 stores the raw flag or null — null means "resolve from the environment
  // at run time", today's behavior and part of the N=1 contract. Pinning at
  // N=1 would freeze a model the task never asked for; §"run time" needs no
  // branch either way, because resolveModel short-circuits on a non-null value.
  const reviewers = options.reviewers.map((slot, index) => ({
    provider: slot.provider,
    model: multi ? pinnedReviewerModel(slot, index) : slot.model ?? null,
    effort: resolveEffort(slot.provider, slot.effort ?? null),
    claudeMaxBudgetUsd: slot.claudeMaxBudgetUsd ?? null
  }));
  const task = {
    schemaVersion: 1,
    taskId,
    requirementMarkdown: requirement,
    requirementSha256: sha256(requirement),
    author: options.author,
    reviewers,
    authorModel: options.authorModel ?? null,
    authorEffort: resolveEffort(options.author, options.authorEffort ?? null),
    publishDir,
    maxRounds: options.maxRounds,
    maxProviderFailures: options.maxProviderFailures,
    authorTimeoutMs: options.authorTimeoutMs,
    reviewerTimeoutMs: options.reviewerTimeoutMs,
    claudeAuthorMaxBudgetUsd: options.claudeAuthorMaxBudgetUsd ?? null,
    createdAt: now()
  };
  await atomicWriteJson(paths.task, task);
  await atomicWriteFile(paths.requirement, requirement);
  await atomicWriteJson(paths.overrides, DEFAULT_OVERRIDES);
  return task;
}

// One reviewer slot: invoke, normalize (no id allocation), commit the capture
// by one atomic rename. Transient retry is invokeWithLimit's, unchanged.
async function runReviewerSlot({ context, slot, adapter, prompt, author, round, schemas, repoRoot, logger }) {
  const files = roundPaths(context.paths.taskDir, round);
  const startedAt = now();
  let review = null;
  const result = await invokeWithLimit({
    role: 'reviewer',
    phase: 'reviewing',
    round,
    provider: adapter,
    prompt,
    schema: schemas.reviewerSchema,
    schemaFile: schemas.reviewerFile,
    timeoutMs: context.task.reviewerTimeoutMs,
    slot: slot.id,
    logger,
    validate(data) {
      if (!schemas.validateReviewer(data)) throw validationError('reviewer output', schemas.validateReviewer);
      review = normalizeSlotReview(data, {
        round,
        priorReviews: context.reviews,
        overrides: context.overrides
      });
    }
  });
  for (const note of review.coercions) {
    logger.stage('reviewer output normalized', { phase: 'reviewing', round, slot: slot.id, note });
  }
  const wrapper = {
    meta: wrapperMeta({
      providerMeta: result.meta,
      role: 'reviewer',
      round,
      prompt,
      startedAt,
      repoRoot,
      extra: { planSha256: sha256(author.plan), slot: slot.id }
    }),
    review: review.normalized
  };
  await atomicWriteJson(files.slotReview(slot.id), wrapper);
  logger.stage('reviewer capture committed', { phase: 'reviewing', round, slot: slot.id, file: files.slotReview(slot.id) });
}

export async function runWorkflow({ repoRoot, taskId, schemas, templates, providers, agentsMd, logger = NOOP_LOGGER }) {
  logger.stage('workflow started or resumed', { phase: 'reconcile' });
  while (true) {
    let context = await loadContext({ repoRoot, taskId, schemas, repair: true });
    // A mismatched runtime must cost zero provider calls, the author's included.
    assertReviewerAdapters(reviewerSlots(context.task), providers.reviewers);
    for (const wrapper of context.reviews) await writeManifest(context, wrapper.meta.round, logger);
    if (context.approval) return finalize(context, logger);

    const review = lastReview(context);
    // Only a reviewer approves a plan. An override rules on a *finding*, not on
    // the plan text: the plan it leaves behind may still be wrong, and a ruling
    // that keeps a real defect (severity_changed) or resolves one of several can
    // introduce flaws downstream that nobody has looked for. Recomputing the
    // gate from findings would let that ruling mint `gate.verdict: 'approved'`
    // for a plan whose only review said changes_requested.
    if (review && review.review.verdict === 'approved') return finalize(context, logger);
    // Blockers cleared while the verdict still reads changes_requested can only
    // be a human ruling — normalizeReviewerOutput binds verdict to findings at
    // review time. That ruling is an explicit request to continue, so it buys
    // one round past the limit that stopped the loop, and the plan has to earn
    // a real verdict. If blockers remain the human has not cleared the path, and
    // spending a round on a finding the author already failed twice would burn
    // money they never authorized.
    if (review && blockingFindings(context.findings).length
      && (review.meta.round >= context.task.maxRounds || hasStalledCriticalFinding(context.findings))) {
      await publishForHuman(context, review, logger);
      logger.stage('workflow needs human review', { phase: 'reviewing', round: review.meta.round });
      return writeState(context, { status: 'needs_human', phase: 'reviewing', round: review.meta.round });
    }

    const latestAuthor = lastAuthor(context);
    const currentRound = latestAuthor && !context.reviews.some((item) => item.meta.round === latestAuthor.files.round)
      ? latestAuthor.files.round
      : (review?.meta.round ?? 0) + 1;
    const files = roundPaths(context.paths.taskDir, currentRound);

    if (!context.authorOutputs.has(currentRound)) {
      const authorPhase = currentRound === 1 ? 'drafting' : 'revising';
      const priorFailures = await failureStatus(context, phaseKeyOf(authorPhase, currentRound));
      if (priorFailures.status === 'needs_human') {
        logger.stage('provider failure limit reached', { phase: authorPhase, round: currentRound });
        return writeState(context, { status: 'needs_human', phase: authorPhase, round: currentRound, errorClass: 'provider_failure_limit' });
      }
      const required = activeFindings(context.findings);
      const previous = lastAuthor(context);
      const prompt = buildAuthorPrompt({
        templates,
        agentsMd,
        requirement: context.requirement,
        previousPlan: previous?.plan ?? null,
        findings: required,
        overrides: context.overrides
      });
      const provider = providers.author;
      const startedAt = now();
      try {
        const result = await invokeWithLimit({
          role: 'author',
          phase: authorPhase,
          round: currentRound,
          provider,
          prompt,
          schema: schemas.authorSchema,
          schemaFile: schemas.authorFile,
          timeoutMs: context.task.authorTimeoutMs,
          logger,
          validate(data) {
            // Normalize before validating, in memory only — the stored bytes
            // stay exactly what the provider returned, so a provider (or
            // fixture) that omits coversFindingIds is accepted with today's
            // semantics instead of rejected. The load path normalizes the same
            // way for legacy rounds, so both paths stay one path.
            const normalized = normalizeAuthorOutput(data);
            if (!schemas.validateAuthor(normalized)) throw validationError('author output', schemas.validateAuthor);
            data.planMarkdown = validatePlanMarkdown(data.planMarkdown);
            validateAuthorResolutions(normalized.resolutions, required);
          }
        });
        const wrapper = {
          meta: wrapperMeta({ providerMeta: result.meta, role: 'author', round: currentRound, prompt, startedAt, repoRoot }),
          output: result.data
        };
        await atomicWriteJson(files.authorOutput, wrapper);
        logger.stage('author output committed', { phase: authorPhase, round: currentRound, file: files.authorOutput });
      } catch (error) {
        return handlePhaseFailure(context, { round: currentRound, phase: authorPhase, provider: provider.name, error, logger });
      }
      continue;
    }

    const author = context.authorOutputs.get(currentRound);
    if (!context.reviews.some((item) => item.meta.round === currentRound)) {
      const roster = reviewerSlots(context.task);
      // One prompt per round, built before any slot decision: it is both what
      // every slot is asked and the fingerprint of what this round is asking.
      // A committed capture belongs to the round's current attempt iff its
      // recorded promptSha256 equals this one; any other fingerprint answers a
      // question that has since changed (in practice: the overrides document
      // moved), so its slot re-runs. The filter runs on every iteration,
      // including the merging one, so an override landing during the fan-out is
      // seen before anything merges.
      const prompt = buildReviewerPrompt({
        templates,
        agentsMd,
        requirement: context.requirement,
        plan: author.plan,
        findings: activeFindings(context.findings),
        closedFindings: closedFindings(context.findings),
        resolutions: author.resolutions,
        overrides: context.overrides
      });
      const promptSha256 = sha256(prompt);
      const committed = context.slotReviews.get(currentRound) ?? new Map();
      const fresh = new Map();
      for (const slot of roster) {
        const entry = committed.get(slot.id);
        if (!entry) continue;
        if (entry.wrapper.meta.promptSha256 === promptSha256) {
          fresh.set(slot.id, entry);
          continue;
        }
        logger.stage('reviewer capture superseded; the round inputs changed', {
          phase: 'reviewing',
          round: currentRound,
          slot: slot.id,
          capturedPromptSha256: entry.wrapper.meta.promptSha256,
          promptSha256
        });
      }
      const pending = roster.filter((slot) => !fresh.has(slot.id));

      if (pending.length) {
        for (const slot of pending) {
          const prior = await failureStatus(context, phaseKeyOf('reviewing', currentRound), slot.id);
          if (prior.status === 'needs_human') {
            logger.stage('provider failure limit reached', { phase: 'reviewing', round: currentRound, slot: slot.id });
            return writeState(context, {
              status: 'needs_human', phase: 'reviewing', round: currentRound, errorClass: 'provider_failure_limit'
            });
          }
        }
        // allSettled, not all: the barrier requires every reviewer to return
        // before anything is decided — a first-failure short-circuit would race
        // the still-running peers' commits against the failure handler.
        const settled = await Promise.allSettled(pending.map((slot) => runReviewerSlot({
          context,
          slot,
          adapter: providers.reviewers[slot.index - 1],
          prompt,
          author,
          round: currentRound,
          schemas,
          repoRoot,
          logger
        })));
        const failures = settled.flatMap((outcome, index) =>
          outcome.status === 'rejected' ? [{ slot: pending[index], error: outcome.reason }] : []);
        if (failures.length) return handleReviewFailures(context, { round: currentRound, failures, logger });
        // Reload; the next iteration finds the barrier reached and merges. The
        // merge always reads committed artifacts, never in-memory results, so
        // a fresh run and a resume share one code path.
        context = await loadContext({ repoRoot, taskId, schemas, repair: true });
        continue;
      }

      const merged = mergeRoundReviews({
        round: currentRound,
        roster,
        slotReviews: fresh,
        promptSha256,
        priorReviews: context.reviews,
        overrides: context.overrides,
        planSha256: sha256(author.plan)
      });
      await atomicWriteJson(files.review, merged);
      logger.stage('round reviews merged', {
        phase: 'reviewing',
        round: currentRound,
        file: files.review,
        reviewers: roster.length,
        verdict: merged.review.verdict
      });
      // Reload through loadContext so the v2 branch's full validation and
      // capture verification run over the bytes just committed.
      context = await loadContext({ repoRoot, taskId, schemas, repair: true });
      await writeManifest(context, currentRound, logger);
      continue;
    }
  }
}

export async function inspectTask({ repoRoot, taskId, schemas, templates = null, agentsMd = '' }) {
  const context = await loadContext({ repoRoot, taskId, schemas, repair: false });
  const review = lastReview(context);
  const author = lastAuthor(context);
  const blocking = blockingFindings(context.findings);
  const base = {
    taskId,
    blockingFindingIds: blocking.map((finding) => finding.id),
    blockingFindings: blocking.map((finding) => ({
      id: finding.id,
      severity: finding.effectiveSeverity,
      planSection: finding.planSection,
      problem: finding.problem,
      requiredChange: finding.requiredChange,
      evidence: finding.evidence,
      lastStatus: finding.lastStatus,
      lastExplanation: finding.lastExplanation ?? null,
      criticalReviewStreak: finding.criticalReviewStreak,
      raisedBy: finding.raisedBy ?? 'R1',
      override: finding.override
    })),
    finalPath: null
  };
  if (context.approval) {
    return {
      ...base,
      status: 'approved',
      phase: 'finalizing',
      round: context.approval.round,
      finalPath: context.paths.final,
      publishedPath: publishedPathFor(context.paths, context.task)
    };
  }
  if (review && blocking.length === 0) {
    return { ...base, status: 'running', phase: 'finalizing', round: review.meta.round };
  }
  if (review && (review.meta.round >= context.task.maxRounds || hasStalledCriticalFinding(context.findings))) {
    return { ...base, status: 'needs_human', phase: 'reviewing', round: review.meta.round };
  }
  const authorPending = Boolean(author && !context.reviews.some((item) => item.meta.round === author.files.round));
  const round = authorPending ? author.files.round : (review?.meta.round ?? 0) + 1;
  const phase = authorPending ? 'reviewing' : round === 1 ? 'drafting' : 'revising';
  if (phase === 'reviewing') {
    // "Pending" carries the fingerprint rule's meaning — no capture, or a
    // superseded one — which needs the round prompt; without templates the
    // caller gets the capture-presence approximation. Worst status wins.
    const roster = reviewerSlots(context.task);
    const committed = context.slotReviews.get(round) ?? new Map();
    let promptSha256 = null;
    if (templates) {
      promptSha256 = sha256(buildReviewerPrompt({
        templates,
        agentsMd,
        requirement: context.requirement,
        plan: author.plan,
        findings: activeFindings(context.findings),
        closedFindings: closedFindings(context.findings),
        resolutions: author.resolutions,
        overrides: context.overrides
      }));
    }
    const pending = roster.filter((slot) => {
      const entry = committed.get(slot.id);
      if (!entry) return true;
      return promptSha256 !== null && entry.wrapper.meta.promptSha256 !== promptSha256;
    });
    const statuses = await Promise.all(
      pending.map((slot) => failureStatus(context, phaseKeyOf('reviewing', round), slot.id))
    );
    const worst = ['needs_human', 'failed', 'running']
      .find((status) => statuses.some((item) => item.status === status)) ?? 'running';
    return { ...base, status: worst, phase, round, pendingReviewerSlots: pending.map((slot) => slot.id) };
  }
  const failures = await failureStatus(context, phaseKeyOf(phase, round));
  return { ...base, status: failures.status, phase, round };
}

export async function updateTaskSettings({
  repoRoot,
  taskId,
  authorTimeoutMs = null,
  reviewerTimeoutMs = null,
  authorEffort = null,
  reviewerEffort = null
}) {
  const paths = taskPaths(repoRoot, taskId);
  const task = await readJson(paths.task);
  // resume --reviewer-effort applies to every slot: effort is not slot
  // identity, and changing it mid-task is already allowed. Roster tasks store
  // it per slot; legacy tasks keep the singular key, today's line untouched.
  const reviewerSettings = Array.isArray(task.reviewers)
    ? {
        reviewers: reviewerEffort
          ? task.reviewers.map((slot) => ({ ...slot, effort: resolveEffort(slot.provider, reviewerEffort) }))
          : task.reviewers
      }
    : {
        reviewerEffort: reviewerEffort ? resolveEffort(task.reviewer, reviewerEffort) : task.reviewerEffort ?? null
      };
  const updated = {
    ...task,
    authorTimeoutMs: authorTimeoutMs ?? task.authorTimeoutMs,
    reviewerTimeoutMs: reviewerTimeoutMs ?? task.reviewerTimeoutMs,
    authorEffort: authorEffort ? resolveEffort(task.author, authorEffort) : task.authorEffort ?? null,
    ...reviewerSettings
  };
  await atomicWriteJson(paths.task, updated);
  return updated;
}

export async function clearFailures({ repoRoot, taskId, reason }) {
  const paths = taskPaths(repoRoot, taskId);
  await readJson(paths.task);
  const entries = await readFailures(paths);
  const lastClearance = entries
    .filter((entry) => entry.kind === 'clearance')
    .reduce((max, entry) => Math.max(max, entry.sequence), 0);
  const open = entries.filter((entry) => entry.kind !== 'clearance' && entry.sequence > lastClearance);
  if (!open.length) throw new Error('no provider failures to clear');
  return recordFailureClearance(paths, { reason });
}

export async function applyOverride({ repoRoot, taskId, schemas, findingId, disposition, severity, reason }) {
  const context = await loadContext({ repoRoot, taskId, schemas, repair: false });
  if (context.approval) throw new Error('approved tasks cannot be overridden');
  validateOverrideInput({ findingId, disposition, severity, reason }, context.findings);
  const entries = [...(context.overrides.entries || [])];
  const next = entries
    .map((entry) => Number(/^O(\d+)$/.exec(entry.id)?.[1] || 0))
    .reduce((max, value) => Math.max(max, value), 0) + 1;
  entries.push({
    id: `O${String(next).padStart(3, '0')}`,
    findingId,
    disposition,
    effectiveSeverity: disposition === 'severity_changed' ? severity : null,
    reason: reason.trim(),
    createdAt: now(),
    actor: 'human',
    source: 'cli'
  });
  await atomicWriteJson(context.paths.overrides, { schemaVersion: 1, entries });
  return entries.at(-1);
}

export async function readFinal({ repoRoot, taskId, publishPath = null }) {
  const paths = taskPaths(repoRoot, taskId);
  const approval = await readJsonIfExists(paths.approval);
  if (!approval) throw new Error('task is not approved');
  const final = await fsp.readFile(paths.final, 'utf8');
  if (sha256(final) !== approval.planSha256) throw new Error('final.md does not match approval.json');
  if (publishPath) {
    const destination = path.resolve(repoRoot, publishPath);
    if (!destination.startsWith(`${repoRoot}${path.sep}`)) throw new Error('publish path escapes repository');
    await atomicWriteFile(destination, final, { mode: 0o644 });
  }
  return { final, path: paths.final };
}

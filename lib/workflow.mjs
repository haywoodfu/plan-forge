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
  blockingFindings,
  collectFindings,
  hasStalledCriticalFinding,
  normalizeReviewerOutput,
  requiredReviewerFindings,
  validateAuthorResolutions,
  validateOverrideInput
} from './findings.mjs';
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

export const DEFAULT_PUBLISH_DIR = 'docs/plans';

function publishedPathFor(paths, task) {
  const dir = task.publishDir ?? DEFAULT_PUBLISH_DIR;
  return assertInside(paths.repoRoot, path.resolve(paths.repoRoot, dir, `${task.taskId}.md`));
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

async function invokeWithLimit({ role, phase, round, provider, prompt, schema, schemaFile, timeoutMs, validate, logger }) {
  let lastError;
  let attemptCount = 0;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    attemptCount = attempt;
    const attemptStartedAt = Date.now();
    logger.stage('provider attempt started', { phase, round, provider: provider.name, attempt });
    let result = null;
    try {
      result = await provider.invoke({
        prompt,
        schema,
        schemaFile,
        timeoutMs,
        onStderr: (chunk) => logger.providerStderr(provider.name, chunk, { phase, round, attempt }),
        onHeartbeat: ({ elapsedMs, pid }) => logger.heartbeat('provider still running', {
          phase,
          round,
          provider: provider.name,
          attempt,
          elapsedSeconds: Math.floor(elapsedMs / 1000),
          pid
        }),
        onSuspend: ({ suspendedMs }) => logger.stage('system suspension detected; provider deadline extended', {
          phase,
          round,
          provider: provider.name,
          attempt,
          suspendedSeconds: Math.floor(suspendedMs / 1000)
        })
      });
      validate(result.data);
      logger.stage('provider attempt completed', {
        phase,
        round,
        provider: provider.name,
        attempt,
        elapsedSeconds: Math.floor((Date.now() - attemptStartedAt) / 1000)
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
        errorClass: normalizedErrorClass(error)
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

async function loadRoundArtifacts({ paths, schemas, repair }) {
  const rounds = await listRounds(paths.taskDir);
  for (let index = 0; index < rounds.length; index += 1) {
    if (rounds[index] !== index + 1) throw new Error('round directories must be contiguous and start at 001');
  }
  const authorOutputs = new Map();
  const reviews = [];

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
    if (!schemas.validateAuthor(author.output)) throw validationError(`round ${files.name} author output`, schemas.validateAuthor);
    if (author.meta?.round !== round || author.meta?.role !== 'author') {
      throw new Error(`round ${files.name} author metadata is invalid`);
    }
    const plan = validatePlanMarkdown(author.output.planMarkdown);
    const resolutionText = jsonText(author.output.resolutions);
    const actualPlan = await readTextIfExists(files.plan);
    const actualResolution = await readTextIfExists(files.resolution);
    if (repair && actualPlan !== plan) await atomicWriteFile(files.plan, plan);
    if (repair && actualResolution !== resolutionText) await atomicWriteFile(files.resolution, resolutionText);
    authorOutputs.set(round, { wrapper: author, plan, resolutions: author.output.resolutions, files });

    const review = await readJsonIfExists(files.review);
    if (review) {
      if (!schemas.validateReviewer(review.review)) throw validationError(`round ${files.name} review`, schemas.validateReviewer);
      if (review.meta.round !== round) throw new Error(`round ${files.name} review metadata has wrong round`);
      if (review.meta.planSha256 !== sha256(plan)) throw new Error(`round ${files.name} review is bound to a different plan`);
      reviews.push(review);
    }
  }
  return { rounds, authorOutputs, reviews };
}

async function loadContext({ repoRoot, taskId, schemas, repair = false }) {
  const paths = taskPaths(repoRoot, taskId);
  const task = await readJson(paths.task);
  if (
    task.schemaVersion !== 1 ||
    task.taskId !== taskId ||
    !['claude', 'codex'].includes(task.author) ||
    !['claude', 'codex'].includes(task.reviewer) ||
    !Number.isInteger(task.maxRounds) || task.maxRounds < 1 ||
    !Number.isInteger(task.maxProviderFailures) || task.maxProviderFailures < 1 ||
    sha256(`${task.requirementMarkdown.trim()}\n`) !== task.requirementSha256
  ) {
    throw new Error('task.json requirement identity is invalid');
  }
  const requirement = await ensureTaskProjection(paths, task, repair);
  const overrides = (await readJsonIfExists(paths.overrides)) ?? DEFAULT_OVERRIDES;
  const artifacts = await loadRoundArtifacts({ paths, schemas, repair });
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

async function failureCount(paths, phaseKey) {
  const entries = await readFailures(paths);
  const lastClearance = entries
    .filter((entry) => entry.kind === 'clearance')
    .reduce((max, entry) => Math.max(max, entry.sequence), 0);
  return entries.filter(
    (entry) => entry.kind !== 'clearance' && entry.phaseKey === phaseKey && entry.sequence > lastClearance
  ).length;
}

async function failureStatus(context, phaseKey) {
  const count = await failureCount(context.paths, phaseKey);
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

async function writeManifest(context, round, logger = NOOP_LOGGER) {
  const files = roundPaths(context.paths.taskDir, round);
  const author = context.authorOutputs.get(round);
  const review = context.reviews.find((item) => item.meta.round === round);
  if (!author || !review) return;
  if (await readTextIfExists(files.manifest) !== null) return;
  await atomicWriteJson(files.manifest, {
    schemaVersion: 1,
    round,
    authorOutputSha256: await fileSha256(files.authorOutput),
    planSha256: sha256(author.plan),
    resolutionSha256: sha256(jsonText(author.resolutions)),
    reviewSha256: await fileSha256(files.review),
    authorMeta: author.wrapper.meta,
    reviewerMeta: review.meta,
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
  // Approved plans are archived into version control automatically; this is
  // the workflow's single sanctioned write outside .plan-forge/.
  const provenance = `<!-- plan-forge: task=${context.task.taskId} round=${approval.round} author=${context.task.author} reviewer=${context.task.reviewer} approvedAt=${approval.approvedAt} planSha256=${approval.planSha256} requirementSha256=${context.task.requirementSha256} -->\n\n`;
  // The archive is self-contained: with inline requirements there may be no
  // requirement file outside the gitignored runtime dir, so the frozen text
  // ships as an appendix of the published plan.
  const requirementAppendix = `\n\n---\n\n## Appendix: Frozen Requirement\n\n${context.task.requirementMarkdown}`;
  const publishedContent = provenance + author.plan.replace(/\n$/, '') + requirementAppendix;
  if (await readTextIfExists(publishedFile) !== publishedContent) {
    await atomicWriteFile(publishedFile, publishedContent, { mode: 0o644 });
  }
  logger.stage('final plan published', { phase: 'finalizing', round: review.meta.round, file: publishedFile });
  context.approval = approval;
  return writeState(context, { status: 'approved', phase: 'finalizing', round: review.meta.round });
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
  const task = {
    schemaVersion: 1,
    taskId,
    requirementMarkdown: requirement,
    requirementSha256: sha256(requirement),
    author: options.author,
    reviewer: options.reviewer,
    authorModel: options.authorModel ?? null,
    reviewerModel: options.reviewerModel ?? null,
    authorEffort: resolveEffort(options.author, options.authorEffort ?? null),
    reviewerEffort: resolveEffort(options.reviewer, options.reviewerEffort ?? null),
    publishDir,
    maxRounds: options.maxRounds,
    maxProviderFailures: options.maxProviderFailures,
    authorTimeoutMs: options.authorTimeoutMs,
    reviewerTimeoutMs: options.reviewerTimeoutMs,
    claudeAuthorMaxBudgetUsd: options.claudeAuthorMaxBudgetUsd ?? null,
    claudeReviewerMaxBudgetUsd: options.claudeReviewerMaxBudgetUsd ?? null,
    createdAt: now()
  };
  await atomicWriteJson(paths.task, task);
  await atomicWriteFile(paths.requirement, requirement);
  await atomicWriteJson(paths.overrides, DEFAULT_OVERRIDES);
  return task;
}

export async function runWorkflow({ repoRoot, taskId, schemas, templates, providers, agentsMd, logger = NOOP_LOGGER }) {
  logger.stage('workflow started or resumed', { phase: 'reconcile' });
  while (true) {
    let context = await loadContext({ repoRoot, taskId, schemas, repair: true });
    for (const wrapper of context.reviews) await writeManifest(context, wrapper.meta.round, logger);
    if (context.approval) return finalize(context, logger);

    const review = lastReview(context);
    if (review && blockingFindings(context.findings).length === 0) return finalize(context, logger);
    if (review && (review.meta.round >= context.task.maxRounds || hasStalledCriticalFinding(context.findings))) {
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
      const required = requiredReviewerFindings(context.findings);
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
            if (!schemas.validateAuthor(data)) throw validationError('author output', schemas.validateAuthor);
            data.planMarkdown = validatePlanMarkdown(data.planMarkdown);
            validateAuthorResolutions(data.resolutions, required);
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
      const priorFailures = await failureStatus(context, phaseKeyOf('reviewing', currentRound));
      if (priorFailures.status === 'needs_human') {
        logger.stage('provider failure limit reached', { phase: 'reviewing', round: currentRound });
        return writeState(context, { status: 'needs_human', phase: 'reviewing', round: currentRound, errorClass: 'provider_failure_limit' });
      }
      const required = requiredReviewerFindings(context.findings);
      const prompt = buildReviewerPrompt({
        templates,
        agentsMd,
        requirement: context.requirement,
        plan: author.plan,
        findings: required,
        resolutions: author.resolutions,
        overrides: context.overrides
      });
      const provider = providers.reviewer;
      const startedAt = now();
      try {
        let review = null;
        const result = await invokeWithLimit({
          role: 'reviewer',
          phase: 'reviewing',
          round: currentRound,
          provider,
          prompt,
          schema: schemas.reviewerSchema,
          schemaFile: schemas.reviewerFile,
          timeoutMs: context.task.reviewerTimeoutMs,
          logger,
          validate(data) {
            if (!schemas.validateReviewer(data)) throw validationError('reviewer output', schemas.validateReviewer);
            review = normalizeReviewerOutput(data, {
              round: currentRound,
              priorReviews: context.reviews,
              overrides: context.overrides
            });
          }
        });
        const { normalized, coercions } = review;
        for (const note of coercions) {
          logger.stage('reviewer output normalized', { phase: 'reviewing', round: currentRound, note });
        }
        const wrapper = {
          meta: wrapperMeta({
            providerMeta: result.meta,
            role: 'reviewer',
            round: currentRound,
            prompt,
            startedAt,
            repoRoot,
            extra: { planSha256: sha256(author.plan) }
          }),
          review: normalized
        };
        await atomicWriteJson(files.review, wrapper);
        logger.stage('review committed', { phase: 'reviewing', round: currentRound, file: files.review });
      } catch (error) {
        return handlePhaseFailure(context, { round: currentRound, phase: 'reviewing', provider: provider.name, error, logger });
      }
      context = await loadContext({ repoRoot, taskId, schemas, repair: true });
      await writeManifest(context, currentRound, logger);
      continue;
    }
  }
}

export async function inspectTask({ repoRoot, taskId, schemas }) {
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
  const updated = {
    ...task,
    authorTimeoutMs: authorTimeoutMs ?? task.authorTimeoutMs,
    reviewerTimeoutMs: reviewerTimeoutMs ?? task.reviewerTimeoutMs,
    authorEffort: authorEffort ? resolveEffort(task.author, authorEffort) : task.authorEffort ?? null,
    reviewerEffort: reviewerEffort ? resolveEffort(task.reviewer, reviewerEffort) : task.reviewerEffort ?? null
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

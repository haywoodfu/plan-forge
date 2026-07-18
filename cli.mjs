#!/usr/bin/env node
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { acquireTaskLock, readJson, runtimeDirIgnored, taskPaths, validateTaskId } from './lib/artifacts.mjs';
import { runDoctor } from './lib/doctor.mjs';
import { createTaskLogger } from './lib/logger.mjs';
import { createClaudeProvider } from './lib/providers/claude.mjs';
import { createCodexProvider } from './lib/providers/codex.mjs';
import { loadPromptTemplates } from './lib/prompts.mjs';
import { loadSchemas } from './lib/schema.mjs';
import { reviewerRosterFromArgs } from './lib/roster.mjs';
import { applyOverride, clearFailures, initializeTask, inspectTask, readFinal, resolveEffort, resolveModel, reviewerSlots, runWorkflow, updateTaskSettings } from './lib/workflow.mjs';

const toolRoot = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const values = {};
  // Ordered [key, value] pairs beside the last-wins map: positional binding
  // for repeated --reviewer needs argv order, which the map cannot carry.
  // Every existing option keeps reading `values`.
  const tokens = [];
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith('--')) throw new Error(`unexpected positional argument: ${token}`);
    const equal = token.indexOf('=');
    if (equal !== -1) {
      values[token.slice(2, equal)] = token.slice(equal + 1);
      tokens.push([token.slice(2, equal), token.slice(equal + 1)]);
      continue;
    }
    const key = token.slice(2);
    const next = rest[index + 1];
    if (!next || next.startsWith('--')) {
      values[key] = true;
      tokens.push([key, true]);
    } else {
      values[key] = next;
      tokens.push([key, next]);
      index += 1;
    }
  }
  return { command, values, tokens };
}

function numberOption(values, key, fallback) {
  if (values[key] == null) return fallback;
  const parsed = Number(values[key]);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`--${key} must be a positive number`);
  return parsed;
}

function repositoryRoot() {
  const result = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('plan-forge must run inside a Git repository');
  return result.stdout.trim();
}

function requireTask(values) {
  return validateTaskId(values.task);
}

function providerFor(name, { repoRoot, model, budget, effort }) {
  if (name === 'codex') return createCodexProvider({ repoRoot, model, effort });
  if (name === 'claude') return createClaudeProvider({ repoRoot, model, maxBudgetUsd: budget, effort });
  throw new Error(`unsupported provider ${name}`);
}

async function buildRuntime(repoRoot, task) {
  const [schemas, templates, agentsMd] = await Promise.all([
    loadSchemas(toolRoot),
    loadPromptTemplates(toolRoot),
    fsp.readFile(path.join(repoRoot, 'AGENTS.md'), 'utf8').catch(() => '')
  ]);
  return {
    schemas,
    templates,
    agentsMd,
    providers: {
      author: providerFor(task.author, {
        repoRoot,
        model: resolveModel(task.author, task.authorModel ?? null),
        budget: task.author === 'claude' ? task.claudeAuthorMaxBudgetUsd : null,
        effort: resolveEffort(task.author, task.authorEffort ?? null)
      }),
      // One adapter per slot, parallel to reviewerSlots. A pinned model
      // short-circuits resolveModel's env lookup; a stored null falls through
      // to it — "frozen at N>1" and "late-bound at N=1" are the same line.
      reviewers: reviewerSlots(task).map((slot) => providerFor(slot.provider, {
        repoRoot,
        model: resolveModel(slot.provider, slot.model),
        budget: slot.provider === 'claude' ? slot.claudeMaxBudgetUsd : null,
        effort: resolveEffort(slot.provider, slot.effort)
      }))
    }
  };
}

function taskOptions(values, tokens) {
  const author = values.author || 'claude';
  if (!['claude', 'codex'].includes(author)) {
    throw new Error('--author and --reviewer must be claude or codex');
  }
  return {
    author,
    reviewers: reviewerRosterFromArgs({ author, tokens, values }),
    authorModel: values['author-model'] || null,
    authorEffort: values['author-effort'] || null,
    publishDir: values['publish-dir'] || null,
    maxRounds: numberOption(values, 'max-rounds', 6),
    maxProviderFailures: numberOption(values, 'max-provider-failures', 2),
    authorTimeoutMs: numberOption(values, 'author-timeout', 1800) * 1000,
    reviewerTimeoutMs: numberOption(values, 'reviewer-timeout', 1200) * 1000,
    claudeAuthorMaxBudgetUsd: values['claude-author-max-budget-usd'] == null
      ? null : numberOption(values, 'claude-author-max-budget-usd', null)
  };
}

async function executeTask(repoRoot, taskId, logger) {
  const task = await readJson(taskPaths(repoRoot, taskId).task);
  const runtime = await buildRuntime(repoRoot, task);
  return runWorkflow({ repoRoot, taskId, logger, ...runtime });
}

function printStatus(status) {
  process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
}

async function main() {
  const { command, values, tokens } = parseArgs(process.argv.slice(2));
  if (!command || command === '--help' || values.help) {
    process.stdout.write('Usage: plan-forge <run|resume|status|show|override|doctor> --task <id> [options]\n');
    return;
  }
  if (command === 'doctor') {
    const report = await runDoctor();
    for (const check of report.checks) {
      process.stdout.write(`${check.ok ? '  ok ' : 'FAIL '} ${check.name} — ${check.detail}\n`);
    }
    process.stdout.write(report.ok ? 'doctor: all checks passed\n' : 'doctor: some checks failed\n');
    if (!report.ok) process.exitCode = 1;
    return;
  }
  const repoRoot = repositoryRoot();
  const taskId = requireTask(values);
  const paths = taskPaths(repoRoot, taskId);

  if (command === 'status') {
    // Templates and AGENTS.md let status report §7.3-accurate pending slots
    // (a superseded capture is pending, not just a missing one).
    const [schemas, templates, agentsMd] = await Promise.all([
      loadSchemas(toolRoot),
      loadPromptTemplates(toolRoot),
      fsp.readFile(path.join(repoRoot, 'AGENTS.md'), 'utf8').catch(() => '')
    ]);
    printStatus(await inspectTask({ repoRoot, taskId, schemas, templates, agentsMd }));
    return;
  }

  if (command === 'show') {
    const result = await readFinal({ repoRoot, taskId, publishPath: values.publish || null });
    process.stdout.write(result.final);
    return;
  }

  const release = await acquireTaskLock(paths, { force: Boolean(values['force-unlock']) });
  const logger = createTaskLogger({ taskDir: paths.taskDir, taskId });
  logger.stage('command started', { command, logFile: logger.logFile });
  try {
    if (command === 'run') {
      const inlineText = typeof values['requirement-text'] === 'string' ? values['requirement-text'] : null;
      const fileArg = typeof values.requirement === 'string' ? values.requirement : null;
      if ((inlineText === null) === (fileArg === null)) {
        throw new Error('provide exactly one of --requirement <file|-> or --requirement-text <text>');
      }
      let requirementText = inlineText;
      if (fileArg === '-') requirementText = fs.readFileSync(0, 'utf8');
      await initializeTask({
        repoRoot,
        taskId,
        requirementFile: fileArg && fileArg !== '-' ? path.resolve(repoRoot, fileArg) : null,
        requirementText,
        options: taskOptions(values, tokens)
      });
      logger.stage('task initialized', {
        requirement: fileArg ?? 'inline text',
        inline: fileArg === null || fileArg === '-'
      });
      if (!(await runtimeDirIgnored(repoRoot))) {
        logger.error('warning: .plan-forge/ is not covered by .gitignore — runtime artifacts will show up in git status');
      }
      printStatus(await executeTask(repoRoot, taskId, logger));
      return;
    }
    if (command === 'resume') {
      const authorTimeoutMs = values['author-timeout'] == null ? null : numberOption(values, 'author-timeout', null) * 1000;
      const reviewerTimeoutMs = values['reviewer-timeout'] == null ? null : numberOption(values, 'reviewer-timeout', null) * 1000;
      const authorEffort = values['author-effort'] || null;
      const reviewerEffort = values['reviewer-effort'] || null;
      if (authorTimeoutMs != null || reviewerTimeoutMs != null || authorEffort != null || reviewerEffort != null) {
        const updated = await updateTaskSettings({ repoRoot, taskId, authorTimeoutMs, reviewerTimeoutMs, authorEffort, reviewerEffort });
        logger.stage('task settings updated', {
          authorTimeoutMs: updated.authorTimeoutMs,
          reviewerTimeoutMs: updated.reviewerTimeoutMs,
          authorEffort: updated.authorEffort,
          reviewerEffort: reviewerSlots(updated).map((slot) => slot.effort).join(',')
        });
      }
      if (values['clear-failures']) {
        const file = await clearFailures({
          repoRoot,
          taskId,
          reason: typeof values.reason === 'string' && values.reason.trim()
            ? values.reason.trim()
            : 'human cleared provider failures via resume --clear-failures'
        });
        logger.stage('provider failures cleared', { file });
      }
      printStatus(await executeTask(repoRoot, taskId, logger));
      return;
    }
    if (command === 'override') {
      const schemas = await loadSchemas(toolRoot);
      const entry = await applyOverride({
        repoRoot,
        taskId,
        schemas,
        findingId: values.finding,
        disposition: values.disposition,
        severity: values.severity ?? null,
        reason: values.reason
      });
      logger.stage('human override committed', {
        finding: entry.findingId,
        disposition: entry.disposition,
        override: entry.id
      });
      printStatus(entry);
      return;
    }
    throw new Error(`unknown command ${command}`);
  } catch (error) {
    logger.error('command failed', { command, errorClass: error.name || 'Error' });
    throw error;
  } finally {
    await release();
  }
}

main().catch((error) => {
  process.stderr.write(`plan-forge: ${error.message}\n`);
  process.exitCode = 1;
});

import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { initializeTask } from '../lib/workflow.mjs';

export const toolRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function plan(label) {
  return `# ${label}

## Goal

Deliver a deterministic plan-review workflow that is safe to resume and straightforward to audit. This section establishes the intended outcome and the constraints that implementations must preserve.

## Implementation

Implement the requested behavior with canonical source artifacts, derived human-readable projections, explicit state reconstruction, and structured provider adapters. Preserve identifiers and validate every model response before committing it.

## Verification

Exercise the workflow with unit tests and fake-provider integration tests, including approval, retries, recovery, and unresolved critical findings. Verify hashes and final artifacts before reporting success.
`;
}

export function fakeProvider(name, outputs, meta = {}) {
  let calls = 0;
  const wrap = (data) => ({
    data: structuredClone(data),
    meta: {
      provider: name,
      model: `${name}-test`,
      cliVersion: 'test',
      usage: null,
      costUsd: null,
      sessionId: null,
      ...meta
    }
  });
  return {
    name,
    get calls() {
      return calls;
    },
    async invoke(request) {
      const next = outputs[calls];
      calls += 1;
      if (next instanceof Error) throw next;
      // A function output sees the invocation (prompt included) and may return
      // either raw data or a full { data, meta } envelope.
      if (typeof next === 'function') {
        const produced = await next(calls, request);
        return produced?.data ? produced : wrap(produced);
      }
      if (!next) throw new Error(`${name} fake provider ran out of outputs`);
      return wrap(next);
    }
  };
}

export async function tempRepo() {
  const repoRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'plan-forge-test-'));
  execFileSync('git', ['init', '-q'], { cwd: repoRoot });
  await fsp.writeFile(path.join(repoRoot, 'AGENTS.md'), '# Test instructions\n');
  await fsp.writeFile(path.join(repoRoot, 'requirement.md'), '# Requirement\nBuild the workflow.\n');
  return repoRoot;
}

export async function initTask(repoRoot, taskId = 'test-task', overrides = {}) {
  const { requirementText = null, ...optionOverrides } = overrides;
  await initializeTask({
    repoRoot,
    taskId,
    requirementFile: requirementText === null ? path.join(repoRoot, 'requirement.md') : null,
    requirementText,
    options: {
      author: 'claude',
      reviewers: [{ provider: 'codex', model: null, effort: null, claudeMaxBudgetUsd: null }],
      authorModel: null,
      maxRounds: 6,
      maxProviderFailures: 2,
      authorTimeoutMs: 5000,
      reviewerTimeoutMs: 5000,
      claudeAuthorMaxBudgetUsd: null,
      ...optionOverrides
    }
  });
}

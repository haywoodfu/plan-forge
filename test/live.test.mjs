import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createClaudeProvider } from '../lib/providers/claude.mjs';
import { createCodexProvider } from '../lib/providers/codex.mjs';
import { loadPromptTemplates } from '../lib/prompts.mjs';
import { loadSchemas } from '../lib/schema.mjs';
import { runWorkflow } from '../lib/workflow.mjs';
import { initTask, tempRepo, toolRoot } from './helpers.mjs';

test('live Claude/Codex workflow smoke test', { skip: process.env.PLAN_FORGE_LIVE !== '1', timeout: 30 * 60 * 1000 }, async (t) => {
  const repoRoot = await tempRepo();
  t.after(() => fsp.rm(repoRoot, { recursive: true, force: true }));
  await fsp.writeFile(
    path.join(repoRoot, 'requirement.md'),
    '# Requirement\nAdd a README section documenting how to run tests. Planning only; do not edit files.\n'
  );
  await initTask(repoRoot, 'live-smoke', {
    maxRounds: 2,
    authorTimeoutMs: 1200000,
    reviewerTimeoutMs: 600000,
    claudeAuthorMaxBudgetUsd: 2
  });
  const result = await runWorkflow({
    repoRoot,
    taskId: 'live-smoke',
    schemas: await loadSchemas(toolRoot),
    templates: await loadPromptTemplates(toolRoot),
    agentsMd: '# Test repository\nPlan only; never edit files.\n',
    providers: {
      author: createClaudeProvider({ repoRoot, maxBudgetUsd: 2 }),
      reviewer: createCodexProvider({ repoRoot })
    }
  });
  assert.ok(['approved', 'needs_human'].includes(result.status));
});

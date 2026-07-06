import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAuthorPrompt, buildReviewerPrompt, loadPromptTemplates } from '../lib/prompts.mjs';
import { plan, toolRoot } from './helpers.mjs';

test('prompt builder includes required artifacts and excludes process environment', async () => {
  const templates = await loadPromptTemplates(toolRoot);
  process.env.PLAN_REVIEW_TEST_SECRET = 'must-not-leak';
  const findings = [{
    id: 'F001', effectiveSeverity: 'blocker', category: 'correctness', planSection: 'Implementation',
    problem: 'broken', evidence: ['src/a.js'], requiredChange: 'fix it', criticalReviewStreak: 1
  }];
  const overrides = { entries: [{ id: 'O001', findingId: 'F099', disposition: 'withdrawn' }] };
  const prompt = buildReviewerPrompt({
    templates,
    agentsMd: '# AGENTS',
    requirement: '# Requirement',
    plan: plan('Current'),
    findings,
    resolutions: [{ findingId: 'F001', action: 'accepted' }],
    overrides
  });
  assert.match(prompt, /F001/);
  assert.match(prompt, /O001/);
  assert.match(prompt, /BEGIN FROZEN REQUIREMENT/);
  assert.doesNotMatch(prompt, /must-not-leak/);

  const author = buildAuthorPrompt({ templates, agentsMd: '# AGENTS', requirement: '# Requirement', previousPlan: null, findings: [], overrides: { entries: [] } });
  assert.match(author, /Author Role/);
});

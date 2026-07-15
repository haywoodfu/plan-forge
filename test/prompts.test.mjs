import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAuthorPrompt, buildReviewerPrompt, loadPromptTemplates } from '../lib/prompts.mjs';
import { plan, toolRoot } from './helpers.mjs';

test('prompt builder includes required artifacts and excludes process environment', async () => {
  const templates = await loadPromptTemplates(toolRoot);
  process.env.PLAN_FORGE_TEST_SECRET = 'must-not-leak';
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

test('the reviewer prompt carries closed findings so recurrence can be declared', async () => {
  const templates = await loadPromptTemplates(toolRoot);
  const prompt = buildReviewerPrompt({
    templates,
    agentsMd: '# AGENTS',
    requirement: '# Requirement',
    plan: plan('Current'),
    findings: [],
    closedFindings: [{
      id: 'F001', effectiveSeverity: 'major', category: 'correctness', planSection: 'Implementation',
      problem: 'the gate was subtractive', evidence: [], requiredChange: 'enumerate the fields',
      lastStatus: 'resolved', lastExplanation: 'author enumerated them', lastReviewedRound: 2
    }],
    resolutions: [],
    overrides: { entries: [] }
  });
  assert.match(prompt, /BEGIN CLOSED FINDINGS/);
  assert.match(prompt, /the gate was subtractive/);
  assert.match(prompt, /author enumerated them/);
});

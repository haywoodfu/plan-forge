import assert from 'node:assert/strict';
import test from 'node:test';
import { loadSchemas, validatePlanMarkdown } from '../lib/schema.mjs';
import { plan, toolRoot } from './helpers.mjs';

test('provider schemas compile with Ajv and reject extra properties', async () => {
  const schemas = await loadSchemas(toolRoot);
  const valid = { planMarkdown: plan('Valid'), resolutions: [] };
  assert.equal(schemas.validateAuthor(valid), true);
  assert.equal(schemas.validateAuthor({ ...valid, unexpected: true }), false);
});

test('provider schemas stay inside the shared structured-output subset', async () => {
  const schemas = await loadSchemas(toolRoot);
  for (const schema of [schemas.authorSchema, schemas.reviewerSchema]) {
    walk(schema);
  }

  function walk(node) {
    if (!node || typeof node !== 'object') return;
    assert.equal('minLength' in node, false);
    assert.equal('pattern' in node, false);
    assert.equal('format' in node, false);
    if (node.type === 'object') {
      assert.equal(node.additionalProperties, false);
      assert.deepEqual(new Set(node.required), new Set(Object.keys(node.properties)));
    }
    for (const value of Object.values(node)) walk(value);
  }
});

test('plan Markdown requires stable headings and sufficient content', () => {
  assert.match(validatePlanMarkdown(plan('Complete')), /^# Complete/);
  assert.throws(() => validatePlanMarkdown('# Too short'), /incomplete/);
});

test('the merged schema cannot drift from the reviewer schema (test 34)', async () => {
  const schemas = await loadSchemas(toolRoot);
  const reviewerItems = (key) => schemas.reviewerSchema.properties[key].items;
  const mergedItems = (key) => schemas.mergedReviewSchema.properties.review.properties[key].items;

  // Every key the reviewer schema requires of a finding body is also required
  // by the merged schema — restating instead of $ref-ing is safe only under
  // this guard. The merged side adds exactly its provenance keys.
  for (const [key, provenance] of [['newFindings', ['raisedBy', 'sourceIndex']], ['previousFindings', ['arbitration']]]) {
    const required = new Set(mergedItems(key).required);
    for (const field of reviewerItems(key).required) {
      assert.ok(required.has(field), `${key}: merged schema is missing required field ${field}`);
    }
    assert.deepEqual(
      [...required].filter((field) => !reviewerItems(key).required.includes(field)).sort(),
      [...provenance].sort()
    );
  }

  // The two schemas' domains are disjoint: a v1 wrapper fails the merged
  // validator, a well-formed v2 one passes.
  const capture = {
    meta: { schemaVersion: 1, role: 'reviewer', round: 1 },
    review: { verdict: 'approved', previousFindings: [], newFindings: [], summary: 'ok' }
  };
  assert.equal(schemas.validateMergedReview(capture), false);
  const merged = {
    meta: {
      schemaVersion: 2, role: 'reviewer', round: 1,
      planSha256: 'b'.repeat(64), promptSha256: 'a'.repeat(64),
      startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:05:00.000Z',
      gitHead: null, gitDirty: null,
      reviewers: [{
        slot: 'R1', provider: 'codex', model: null, cliVersion: 'test', effort: 'high',
        startedAt: '2026-01-01T00:00:00.000Z', completedAt: '2026-01-01T00:04:00.000Z',
        usage: null, costUsd: null, sessionId: null, captureSha256: 'c'.repeat(64)
      }]
    },
    review: {
      verdict: 'approved', summary: 'ok', summaries: [{ slot: 'R1', summary: 'ok' }],
      previousFindings: [], newFindings: []
    }
  };
  assert.equal(schemas.validateMergedReview(merged), true, JSON.stringify(schemas.validateMergedReview.errors));
});

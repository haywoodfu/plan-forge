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

import assert from 'node:assert/strict';
import test from 'node:test';
import { primaryModelFromEnvelope } from '../lib/providers/claude.mjs';

test('claude adapter derives the primary model from envelope modelUsage', () => {
  const envelope = {
    modelUsage: {
      'claude-haiku-4-5-20251001': { outputTokens: 15 },
      'claude-fable-5': { outputTokens: 2273 }
    }
  };
  assert.equal(primaryModelFromEnvelope(envelope), 'claude-fable-5');
  assert.equal(primaryModelFromEnvelope({}), null);
  assert.equal(primaryModelFromEnvelope({ modelUsage: {} }), null);
});

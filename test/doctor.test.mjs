import assert from 'node:assert/strict';
import test from 'node:test';
import { missingFlags, runDoctor } from '../lib/doctor.mjs';

test('missingFlags detects absent flags in help text', () => {
  assert.deepEqual(missingFlags('--foo --bar\n  --baz <v>', ['--foo', '--baz']), []);
  assert.deepEqual(missingFlags('--foo only', ['--foo', '--gone']), ['--gone']);
  assert.deepEqual(missingFlags(null, ['--foo']), ['--foo']);
});

test('runDoctor reports environment checks without invoking models', async () => {
  const report = await runDoctor();
  const byName = Object.fromEntries(report.checks.map((check) => [check.name, check]));
  for (const name of ['node', 'ajv', 'git repository', 'claude', 'codex']) {
    assert.ok(byName[name], `missing check ${name}`);
  }
  assert.equal(byName.node.ok, true);
  assert.equal(byName.ajv.ok, true);
  assert.equal(typeof report.ok, 'boolean');
});

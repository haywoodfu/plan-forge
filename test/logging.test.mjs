import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createTaskLogger } from '../lib/logger.mjs';
import { processFailure, runProcess } from '../lib/process.mjs';

test('connection failures during sleep/wake cycles classify as retryable', () => {
  const base = { code: 1, signal: null, timedOut: false, overflow: false, stdout: '', stderr: '' };
  const refused = processFailure('claude', {
    ...base,
    stdout: '{"is_error":true,"result":"API Error: Unable to connect to API (ConnectionRefused)"}'
  });
  assert.equal(refused.retryable, true);
  const logic = processFailure('claude', { ...base, stderr: 'invalid flag usage' });
  assert.equal(logic.retryable, false);
});

test('task logger mirrors stage and provider stderr to terminal and run.log', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'plan-review-log-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  let terminal = '';
  const logger = createTaskLogger({
    taskDir: root,
    taskId: 'logging-test',
    stderr: { write(chunk) { terminal += chunk; } }
  });

  logger.stage('provider attempt started', { phase: 'drafting', round: 1 });
  logger.providerStderr('claude', 'first line\nsecond line\n', { round: 1 });

  const persisted = await fsp.readFile(logger.logFile, 'utf8');
  assert.equal(persisted, terminal);
  assert.match(persisted, /\[stage\] provider attempt started/);
  assert.match(persisted, /\[claude:stderr\] first line/);
  assert.match(persisted, /\[claude:stderr\] second line/);
});

test('suspension gaps extend the deadline instead of killing a healthy provider', async () => {
  const child = ['-e', 'setTimeout(() => process.exit(0), 400)'];

  const killed = await runProcess(process.execPath, child, {
    timeoutMs: 250,
    timeoutCheckMs: 25,
    suspensionThresholdMs: 50
  });
  assert.equal(killed.timedOut, true);

  const suspensions = [];
  const promise = runProcess(process.execPath, child, {
    timeoutMs: 250,
    timeoutCheckMs: 25,
    suspensionThresholdMs: 50,
    onSuspend(event) { suspensions.push(event); }
  });
  const blockUntil = Date.now() + 300;
  while (Date.now() < blockUntil) {
    // Busy-wait blocks this event loop, starving the deadline checker the same
    // way system sleep does; the child process keeps running unaffected.
  }
  const survived = await promise;
  assert.equal(survived.timedOut, false);
  assert.equal(survived.code, 0);
  assert.ok(suspensions.length >= 1);
  assert.ok(suspensions[0].suspendedMs > 50);
});

test('runProcess captures large stdout without pipe truncation', async () => {
  const result = await runProcess(process.execPath, [
    '-e',
    'process.stdout.write("x".repeat(262144)); process.exit(0)'
  ], { timeoutMs: 10000 });
  assert.equal(result.code, 0);
  assert.equal(result.stdout.length, 262144);
});

test('runProcess streams stderr and emits heartbeats while a provider is running', async () => {
  const stderr = [];
  const heartbeats = [];
  const result = await runProcess(process.execPath, [
    '-e',
    "process.stderr.write('provider progress\\n'); setTimeout(() => process.exit(0), 80)"
  ], {
    timeoutMs: 1000,
    heartbeatMs: 10,
    onStderr(chunk) { stderr.push(String(chunk)); },
    onHeartbeat(event) { heartbeats.push(event); }
  });

  assert.equal(result.code, 0);
  assert.match(stderr.join(''), /provider progress/);
  assert.ok(heartbeats.length >= 1);
  assert.ok(heartbeats.every((event) => event.elapsedMs >= 0 && Number.isInteger(event.pid)));
});

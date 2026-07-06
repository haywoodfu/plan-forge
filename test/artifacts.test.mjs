import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { acquireTaskLock, atomicWriteJson, taskPaths, validateTaskId } from '../lib/artifacts.mjs';

test('task ids reject traversal and task locks reject live concurrent owners', async (t) => {
  assert.throws(() => validateTaskId('../escape'), /task id/);
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'plan-review-lock-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const paths = taskPaths(root, 'lock-test');
  const release = await acquireTaskLock(paths);
  await assert.rejects(() => acquireTaskLock(paths), /locked/);
  await release();
  const releaseAgain = await acquireTaskLock(paths);
  await releaseAgain();
});

test('dead local lock owners are reclaimed', async (t) => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'plan-review-stale-lock-'));
  t.after(() => fsp.rm(root, { recursive: true, force: true }));
  const paths = taskPaths(root, 'stale-lock');
  await fsp.mkdir(paths.lock, { recursive: true });
  await atomicWriteJson(path.join(paths.lock, 'owner.json'), {
    token: 'stale', pid: 2147483647, hostname: os.hostname(), taskId: 'stale-lock', createdAt: new Date(0).toISOString()
  });
  const release = await acquireTaskLock(paths);
  await release();
});

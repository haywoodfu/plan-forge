import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const TASK_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/;

export function validateTaskId(taskId) {
  if (!TASK_ID_PATTERN.test(String(taskId || ''))) {
    throw new Error('task id must match [a-z0-9][a-z0-9._-]{0,79}');
  }
  return taskId;
}

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function jsonText(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

export function assertInside(root, candidate) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error(`path escapes allowed root: ${candidate}`);
  }
  return resolved;
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await fsp.open(directory, fs.constants.O_RDONLY);
    await handle.sync();
  } catch (error) {
    if (!['EINVAL', 'ENOTSUP', 'EISDIR'].includes(error.code)) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function atomicWriteFile(file, content, { mode = 0o600 } = {}) {
  const directory = path.dirname(file);
  await fsp.mkdir(directory, { recursive: true });
  const temp = path.join(directory, `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fsp.open(temp, 'wx', mode);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fsp.rename(temp, file);
    await syncDirectory(directory);
  } finally {
    await handle?.close().catch(() => undefined);
    await fsp.unlink(temp).catch(() => undefined);
  }
}

export async function atomicWriteJson(file, value) {
  await atomicWriteFile(file, jsonText(value));
}

export async function readJson(file) {
  return JSON.parse(await fsp.readFile(file, 'utf8'));
}

export async function readJsonIfExists(file) {
  try {
    return await readJson(file);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function readTextIfExists(file) {
  try {
    return await fsp.readFile(file, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function fileSha256(file) {
  return sha256(await fsp.readFile(file));
}

export function taskPaths(repoRoot, taskId) {
  validateTaskId(taskId);
  const runtimeRoot = path.join(repoRoot, '.plan-forge');
  const taskDir = assertInside(runtimeRoot, path.join(runtimeRoot, taskId));
  return {
    repoRoot,
    runtimeRoot,
    taskDir,
    task: path.join(taskDir, 'task.json'),
    requirement: path.join(taskDir, 'requirement.md'),
    state: path.join(taskDir, 'state.json'),
    overrides: path.join(taskDir, 'overrides.json'),
    approval: path.join(taskDir, 'approval.json'),
    final: path.join(taskDir, 'final.md'),
    failures: path.join(taskDir, 'failures'),
    rounds: path.join(taskDir, 'rounds'),
    lock: path.join(taskDir, '.lock')
  };
}

export function roundPaths(taskDir, round) {
  const name = String(round).padStart(3, '0');
  const dir = path.join(taskDir, 'rounds', name);
  const reviewsDir = path.join(dir, 'reviews');
  return {
    round,
    name,
    dir,
    authorOutput: path.join(dir, 'author-output.json'),
    plan: path.join(dir, 'plan.md'),
    resolution: path.join(dir, 'resolution.json'),
    review: path.join(dir, 'review.json'),
    reviewsDir,
    slotReview: (slotId) => path.join(reviewsDir, `${slotId}.json`),
    manifest: path.join(dir, 'manifest.json')
  };
}

export async function listRounds(taskDir) {
  try {
    const entries = await fsp.readdir(path.join(taskDir, 'rounds'), { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && /^\d{3}$/.test(entry.name))
      .map((entry) => Number(entry.name))
      .sort((a, b) => a - b);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

export async function acquireTaskLock(paths, { force = false } = {}) {
  await fsp.mkdir(paths.taskDir, { recursive: true });
  const token = crypto.randomUUID();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await fsp.mkdir(paths.lock);
      await atomicWriteJson(path.join(paths.lock, 'owner.json'), {
        token,
        pid: process.pid,
        hostname: os.hostname(),
        taskId: path.basename(paths.taskDir),
        createdAt: new Date().toISOString()
      });
      return async () => {
        const owner = await readJsonIfExists(path.join(paths.lock, 'owner.json')).catch(() => null);
        if (owner?.token === token) await fsp.rm(paths.lock, { recursive: true, force: true });
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = await readJsonIfExists(path.join(paths.lock, 'owner.json')).catch(() => null);
      const reclaimable = owner?.hostname === os.hostname() && !isProcessAlive(owner.pid);
      if (force || reclaimable) {
        await fsp.rm(paths.lock, { recursive: true, force: true });
        continue;
      }
      throw new Error(`task is locked${owner ? ` by pid ${owner.pid} on ${owner.hostname}` : ''}`);
    }
  }
  throw new Error('failed to acquire task lock');
}

export async function runtimeDirIgnored(repoRoot) {
  const text = await readTextIfExists(path.join(repoRoot, '.gitignore'));
  if (!text) return false;
  const rules = new Set(text.split('\n').map((line) => line.trim()));
  return ['.plan-forge', '.plan-forge/'].some((rule) => rules.has(rule));
}

export function gitSnapshot(repoRoot) {
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' });
  const status = spawnSync('git', ['status', '--porcelain'], { cwd: repoRoot, encoding: 'utf8' });
  return {
    head: head.status === 0 ? head.stdout.trim() : null,
    dirty: status.status === 0 ? Boolean(status.stdout.trim()) : null
  };
}

export function commandVersion(command, args = ['--version']) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) return null;
  return (result.stdout || result.stderr || '').trim() || null;
}

async function appendFailureEntry(paths, entry) {
  await fsp.mkdir(paths.failures, { recursive: true });
  const entries = await fsp.readdir(paths.failures).catch(() => []);
  const next = entries
    .map((name) => Number(/^([0-9]{6})\.json$/.exec(name)?.[1] || 0))
    .reduce((max, value) => Math.max(max, value), 0) + 1;
  const file = path.join(paths.failures, `${String(next).padStart(6, '0')}.json`);
  await atomicWriteJson(file, {
    schemaVersion: 1,
    sequence: next,
    occurredAt: new Date().toISOString(),
    ...entry
  });
  return file;
}

export async function recordFailure(paths, event) {
  return appendFailureEntry(paths, { kind: 'failure', ...event });
}

export async function recordFailureClearance(paths, { reason, actor = 'human', source = 'cli' }) {
  return appendFailureEntry(paths, { kind: 'clearance', reason, actor, source });
}

export async function readFailures(paths) {
  try {
    const entries = (await fsp.readdir(paths.failures))
      .filter((name) => /^\d{6}\.json$/.test(name))
      .sort();
    return await Promise.all(entries.map((name) => readJson(path.join(paths.failures, name))));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

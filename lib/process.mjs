import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export class ProviderError extends Error {
  constructor(message, { retryable = false, incomplete = false, details = null } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.retryable = retryable;
    this.incomplete = incomplete;
    this.details = details;
  }
}

export function runProcess(command, args, {
  cwd,
  input = '',
  timeoutMs,
  maxBuffer = 20 * 1024 * 1024,
  heartbeatMs = 15000,
  timeoutCheckMs = 1000,
  suspensionThresholdMs = 5000,
  onHeartbeat = null,
  onStderr = null,
  onSuspend = null
} = {}) {
  return new Promise((resolve, reject) => {
    const notify = (callback, value) => {
      if (!callback) return;
      try {
        callback(value);
      } catch {
        // Observability callbacks must not terminate the provider process.
      }
    };
    // stdout goes to a temp file, not a pipe: some compiled CLIs (claude 2.1.x
    // is a Bun binary) drop buffered pipe output past one 8 KiB chunk when the
    // process exits before the reader drains — silently truncating large JSON
    // envelopes. File writes have no backpressure, so nothing can be lost.
    // stderr stays piped for live progress streaming.
    const stdoutFile = path.join(os.tmpdir(), `plan-review-stdout-${process.pid}-${crypto.randomUUID()}.log`);
    let stdoutFd = fs.openSync(stdoutFile, 'w');
    const collectStdout = () => {
      if (stdoutFd !== null) {
        try { fs.closeSync(stdoutFd); } catch { /* already closed */ }
        stdoutFd = null;
      }
      try {
        const size = fs.statSync(stdoutFile).size;
        if (size > maxBuffer) {
          overflow = true;
          return '';
        }
        return fs.readFileSync(stdoutFile, 'utf8');
      } catch {
        return '';
      } finally {
        fs.rmSync(stdoutFile, { force: true });
      }
    };
    const child = spawn(command, args, {
      cwd,
      env: process.env,
      detached: process.platform !== 'win32',
      stdio: ['pipe', stdoutFd, 'pipe']
    });
    const stderr = [];
    let stderrBytes = 0;
    let timedOut = false;
    let overflow = false;

    const kill = () => {
      if (child.killed) return;
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM');
        else child.kill('SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    };

    // Wall-clock timeouts would count time spent in system sleep (laptop lid
    // closed), killing healthy providers on wake. Track tick gaps: a gap far
    // beyond the check interval means the host was suspended, so the deadline
    // is extended by that gap and the timeout only counts awake time.
    let deadline = Date.now() + timeoutMs;
    let lastTick = Date.now();
    let killTimer = null;
    const timer = setInterval(() => {
      const nowTs = Date.now();
      const gap = nowTs - lastTick - timeoutCheckMs;
      lastTick = nowTs;
      if (gap > suspensionThresholdMs) {
        deadline += gap;
        notify(onSuspend, { suspendedMs: gap });
      }
      if (nowTs >= deadline && !timedOut) {
        timedOut = true;
        kill();
        killTimer = setTimeout(() => {
          try {
            if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
            else child.kill('SIGKILL');
          } catch {
            // Process already exited.
          }
        }, 2000);
        killTimer.unref();
      }
    }, timeoutCheckMs);
    timer.unref();
    const startedAt = Date.now();
    const heartbeat = onHeartbeat && heartbeatMs > 0
      ? setInterval(() => notify(onHeartbeat, { elapsedMs: Date.now() - startedAt, pid: child.pid }), heartbeatMs)
      : null;
    heartbeat?.unref();

    child.stderr.on('data', (chunk) => {
      notify(onStderr, chunk);
      stderrBytes += chunk.length;
      if (stderrBytes <= maxBuffer) stderr.push(chunk);
      else {
        overflow = true;
        kill();
      }
    });
    child.on('error', (error) => {
      clearInterval(timer);
      if (killTimer) clearTimeout(killTimer);
      if (heartbeat) clearInterval(heartbeat);
      collectStdout();
      reject(error);
    });
    child.on('close', (code, signal) => {
      clearInterval(timer);
      if (killTimer) clearTimeout(killTimer);
      if (heartbeat) clearInterval(heartbeat);
      const stdout = collectStdout();
      resolve({
        code,
        signal,
        timedOut,
        overflow,
        stdout,
        stderr: Buffer.concat(stderr).toString('utf8')
      });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
}

const TRANSIENT = /rate.?limit|overloaded|temporar|timeout|timed out|stream disconnected|connection (?:closed|reset|refused)|connectionrefused|unable to connect|econnrefused|econnreset|enotfound|etimedout|network error|transport|server error|service unavailable|429|502|503|504/i;

export function processFailure(provider, result) {
  const combined = `${result.stderr}\n${result.stdout}`.trim();
  const summary = combined.slice(-1200) || `${provider} exited without output`;
  return new ProviderError(
    result.timedOut ? `${provider} timed out` : result.overflow ? `${provider} output exceeded limit` : `${provider} failed: ${summary}`,
    {
      retryable: result.timedOut || result.overflow || TRANSIENT.test(combined),
      details: { code: result.code, signal: result.signal, timedOut: result.timedOut, overflow: result.overflow }
    }
  );
}

import fs from 'node:fs';
import path from 'node:path';

function fieldText(fields) {
  return Object.entries(fields || {})
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(' ');
}

export function createTaskLogger({ taskDir, taskId, stderr = process.stderr }) {
  const logFile = path.join(taskDir, 'run.log');
  const write = (kind, message, fields = {}) => {
    const suffix = fieldText(fields);
    const line = `[${new Date().toISOString()}] [${taskId}] [${kind}] ${message}${suffix ? ` ${suffix}` : ''}\n`;
    try {
      stderr.write(line);
    } catch {
      // Logging must not break the workflow.
    }
    try {
      fs.mkdirSync(taskDir, { recursive: true });
      fs.appendFileSync(logFile, line, { encoding: 'utf8', mode: 0o600 });
    } catch {
      // The terminal stream remains available when persistent logging fails.
    }
  };

  return {
    logFile,
    stage(message, fields) {
      write('stage', message, fields);
    },
    heartbeat(message, fields) {
      write('heartbeat', message, fields);
    },
    providerStderr(provider, chunk, fields = {}) {
      const text = String(chunk || '').replace(/\r/g, '');
      for (const line of text.split('\n')) {
        if (line.trim()) write(`${provider}:stderr`, line, fields);
      }
    },
    error(message, fields) {
      write('error', message, fields);
    }
  };
}

export const NOOP_LOGGER = {
  logFile: null,
  stage() {},
  heartbeat() {},
  providerStderr() {},
  error() {}
};

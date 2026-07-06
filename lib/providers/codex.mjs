import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { commandVersion } from '../artifacts.mjs';
import { processFailure, ProviderError, runProcess } from '../process.mjs';

function parseEvents(text) {
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      // stderr/progress stays outside the structured audit metadata.
    }
  }
  return events;
}

export function createCodexProvider({ repoRoot, model = null, effort = null }) {
  return {
    name: 'codex',
    async invoke({ prompt, schemaFile, timeoutMs, onHeartbeat, onStderr, onSuspend }) {
      const tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'plan-forge-codex-'));
      const outputFile = path.join(tempDir, 'last-message.json');
      const args = [
        'exec',
        '--cd', repoRoot,
        '--sandbox', 'read-only',
        '--ephemeral',
        '--ignore-user-config',
        '--disable', 'hooks',
        '--color', 'never',
        '--json',
        '--output-schema', schemaFile,
        '--output-last-message', outputFile
      ];
      if (model) args.push('--model', model);
      if (effort) args.push('-c', `model_reasoning_effort=${effort}`);
      args.push('-');

      try {
        const result = await runProcess('codex', args, {
          cwd: repoRoot,
          input: prompt,
          timeoutMs,
          onHeartbeat,
          onStderr,
          onSuspend
        });
        if (result.code !== 0) throw processFailure('codex', result);
        let text;
        try {
          text = await fsp.readFile(outputFile, 'utf8');
        } catch (error) {
          throw new ProviderError(`codex did not produce output-last-message: ${error.message}`, { incomplete: true });
        }
        let data;
        try {
          data = JSON.parse(text);
        } catch (error) {
          throw new ProviderError(`codex returned invalid JSON: ${error.message}`, { incomplete: true });
        }
        const events = parseEvents(result.stdout);
        const completed = [...events].reverse().find((event) => event.type === 'turn.completed');
        const started = events.find((event) => event.type === 'thread.started');
        return {
          data,
          meta: {
            provider: 'codex',
            model,
            effort,
            cliVersion: commandVersion('codex'),
            usage: completed?.usage ?? null,
            costUsd: null,
            sessionId: started?.thread_id ?? null
          }
        };
      } finally {
        await fsp.rm(tempDir, { recursive: true, force: true });
      }
    }
  };
}

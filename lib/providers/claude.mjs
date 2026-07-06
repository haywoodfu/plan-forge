import { commandVersion } from '../artifacts.mjs';
import { processFailure, ProviderError, runProcess } from '../process.mjs';

export function primaryModelFromEnvelope(envelope) {
  const usage = envelope?.modelUsage;
  if (!usage || typeof usage !== 'object') return null;
  const entries = Object.entries(usage);
  if (!entries.length) return null;
  return entries.sort((a, b) => (b[1]?.outputTokens ?? 0) - (a[1]?.outputTokens ?? 0))[0][0];
}

export function createClaudeProvider({ repoRoot, model = null, maxBudgetUsd = null, effort = null }) {
  return {
    name: 'claude',
    async invoke({ prompt, schema, timeoutMs, onHeartbeat, onStderr, onSuspend }) {
      const args = [
        '--safe-mode',
        '--print',
        '--no-session-persistence',
        '--permission-mode', 'dontAsk',
        '--tools', 'Read,Glob,Grep',
        '--output-format', 'json',
        '--json-schema', JSON.stringify(schema)
      ];
      if (model) args.push('--model', model);
      if (effort) args.push('--effort', effort);
      if (maxBudgetUsd != null) args.push('--max-budget-usd', String(maxBudgetUsd));

      const result = await runProcess('claude', args, {
        cwd: repoRoot,
        input: prompt,
        timeoutMs,
        onHeartbeat,
        onStderr,
        onSuspend
      });
      if (result.code !== 0) throw processFailure('claude', result);
      let envelope;
      try {
        envelope = JSON.parse(result.stdout);
      } catch (error) {
        throw new ProviderError(`claude returned invalid JSON envelope: ${error.message}`, { incomplete: true });
      }
      if (!envelope.structured_output || typeof envelope.structured_output !== 'object') {
        throw new ProviderError('claude response is missing structured_output', { incomplete: true });
      }
      return {
        data: envelope.structured_output,
        meta: {
          provider: 'claude',
          model: model ?? envelope.model ?? primaryModelFromEnvelope(envelope),
          cliVersion: commandVersion('claude'),
          effort,
          usage: envelope.usage ?? envelope.modelUsage ?? null,
          costUsd: envelope.total_cost_usd ?? null,
          sessionId: envelope.session_id ?? null
        }
      };
    }
  };
}

import { spawnSync } from 'node:child_process';
import { runProcess } from './process.mjs';

// Every CLI flag the provider adapters pass. A missing flag on the user's
// installed CLI version fails fast here instead of mid-run after a paid call.
export const REQUIRED_CLI_FLAGS = {
  claude: {
    versionArgs: ['--version'],
    helpArgs: ['--help'],
    flags: [
      '--safe-mode',
      '--print',
      '--no-session-persistence',
      '--permission-mode',
      '--tools',
      '--effort',
      '--json-schema',
      '--output-format',
      '--max-budget-usd'
    ]
  },
  codex: {
    versionArgs: ['--version'],
    helpArgs: ['exec', '--help'],
    flags: [
      '--cd',
      '--sandbox',
      '--ephemeral',
      '--ignore-user-config',
      '--output-schema',
      '--output-last-message',
      '--json'
    ]
  }
};

// spawnSync truncates large outputs from some compiled CLIs at one 8 KiB pipe
// chunk (claude --help is ~13 KiB), so long captures must stream via spawn.
export async function captureOutput(command, args) {
  try {
    const result = await runProcess(command, args, { timeoutMs: 15000 });
    if (result.code !== 0) return null;
    return `${result.stdout}\n${result.stderr}`;
  } catch {
    return null;
  }
}

export function captureShort(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.error || result.status !== 0) return null;
  return `${result.stdout}\n${result.stderr}`;
}

export function missingFlags(helpText, flags) {
  return flags.filter((flag) => !String(helpText || '').includes(flag));
}

export async function runDoctor() {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok, detail });

  add('node', true, process.version);

  try {
    await import('ajv');
    add('ajv', true, 'resolvable');
  } catch {
    add('ajv', false, 'not resolvable — run npm install where the tool is installed');
  }

  const gitTop = captureShort('git', ['rev-parse', '--show-toplevel']);
  add('git repository', Boolean(gitTop), gitTop ? gitTop.trim() : 'not inside a git repository');

  for (const [cli, spec] of Object.entries(REQUIRED_CLI_FLAGS)) {
    const version = captureShort(cli, spec.versionArgs);
    if (version === null) {
      add(cli, false, 'not found on PATH');
      add(`${cli} flags`, false, 'skipped — CLI missing');
      continue;
    }
    add(cli, true, version.trim().split('\n')[0]);
    const help = await captureOutput(cli, spec.helpArgs);
    const missing = missingFlags(help, spec.flags);
    add(
      `${cli} flags`,
      missing.length === 0,
      missing.length ? `missing: ${missing.join(', ')}` : `all ${spec.flags.length} required flags present`
    );
  }

  return { ok: checks.every((check) => check.ok), checks };
}

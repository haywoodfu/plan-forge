import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('plugin skill copy stays in sync with the root SKILL.md', async () => {
  const rootSkill = await fsp.readFile(path.join(root, 'SKILL.md'), 'utf8');
  const pluginSkill = await fsp.readFile(path.join(root, 'skills', 'plan-forge', 'SKILL.md'), 'utf8');
  assert.equal(pluginSkill, rootSkill, 'skills/plan-forge/SKILL.md must be an exact copy of SKILL.md');
});

test('plugin, marketplace, and npm manifests agree', async () => {
  const pkg = JSON.parse(await fsp.readFile(path.join(root, 'package.json'), 'utf8'));
  const plugin = JSON.parse(await fsp.readFile(path.join(root, '.claude-plugin', 'plugin.json'), 'utf8'));
  const marketplace = JSON.parse(await fsp.readFile(path.join(root, '.claude-plugin', 'marketplace.json'), 'utf8'));
  const codexPlugin = JSON.parse(await fsp.readFile(path.join(root, '.codex-plugin', 'plugin.json'), 'utf8'));
  const codexMarketplace = JSON.parse(await fsp.readFile(path.join(root, '.agents', 'plugins', 'marketplace.json'), 'utf8'));
  assert.equal(plugin.name, 'plan-forge');
  assert.equal(plugin.version, pkg.version);
  assert.equal(marketplace.plugins.length, 1);
  assert.equal(marketplace.plugins[0].name, plugin.name);
  assert.equal(marketplace.plugins[0].source, './');
  assert.equal(codexPlugin.name, plugin.name);
  assert.equal(codexPlugin.version, pkg.version);
  assert.equal(codexMarketplace.plugins.length, 1);
  assert.equal(codexMarketplace.plugins[0].name, codexPlugin.name);
  assert.equal(codexMarketplace.plugins[0].source.path, './');
});

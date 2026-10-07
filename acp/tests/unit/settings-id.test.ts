// Regression tests for issue #2 — F10: agent ids were validated with a denylist of
// whitespace/slashes only, so __proto__ / constructor / prototype were accepted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'acp-settings-'));
process.env.ACP_STATE_DIR = tmp;

const { isValidAgentId, saveSettings, USER_CONFIG_FILE } = await import('../../src/config/settings.ts');

test('F10: reserved / malformed ids are rejected', () => {
  for (const bad of ['__proto__', 'constructor', 'prototype']) {
    assert.equal(isValidAgentId(bad), false, `${bad} must be rejected`);
    assert.throws(() => saveSettings({ agents: { [bad]: { enabled: true } } } as any), /非法 id/);
  }
  assert.equal(isValidAgentId(''), false);
  assert.equal(isValidAgentId('a b'), false);
  assert.equal(isValidAgentId('a/b'), false);
  assert.equal(isValidAgentId('a\\b'), false);
});

test('F10: legitimate ids are accepted', () => {
  for (const ok of ['codex', 'my-agent', 'my_agent_2', 'GeminiCLI']) {
    assert.equal(isValidAgentId(ok), true, `${ok} should be valid`);
  }
});

test('F10: a rejected save writes nothing', () => {
  // Computed key: `{ '__proto__': x }` literal would set the prototype, not an entry.
  assert.throws(() => saveSettings({ agents: { ['__proto__']: { enabled: false } } } as any));
  // No config file should exist — validation runs before any write.
  let content = '';
  try { content = readFileSync(USER_CONFIG_FILE, 'utf8'); } catch { /* absent is the expected state */ }
  assert.ok(!content.includes('__proto__'), 'rejected payload must not be persisted');
});

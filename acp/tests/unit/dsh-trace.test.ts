// Unit tests for the dsh event-trail helpers (the console now shows what the agent DID, not
// only what it said). Both helpers face outside input: a tool call's shape varies per tool,
// and a tool result can be megabytes. Nothing is spawned here — pure functions, no model calls.
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.ACP_STATE_DIR = mkdtempSync(join(tmpdir(), 'acp-dsh-trace-'));
process.env.WORKSPACE_DIR = mkdtempSync(join(tmpdir(), 'acp-ws-'));
process.env.DSH_BIN = join(process.env.ACP_STATE_DIR, 'fake-bin.js');

const { toolCallDetail, resultDigest } = await import('../../src/drivers/dsh-driver.ts');

test('toolCallDetail reads as one line: tool + its identifying value, never raw JSON', () => {
  assert.equal(toolCallDetail('read', { file_path: 'D:/x/y.ts', limit: 3 }), 'read D:/x/y.ts');
  assert.equal(toolCallDetail('pwsh', { command: 'Get-ChildItem', description: 'list' }), 'pwsh Get-ChildItem');
  assert.equal(toolCallDetail('glob', { pattern: '**/package.json' }), 'glob **/package.json');
  assert.equal(toolCallDetail('grep', { pattern: 'TODO', path: 'src/' }), 'grep TODO');
  assert.equal(toolCallDetail('noop', undefined), 'noop', 'a shapeless call still names the tool');
  // Unknown shapes fall back to clipped JSON — never silent, never huge.
  const odd = toolCallDetail('odd', { a: 'x'.repeat(400) });
  assert.ok(odd.startsWith('odd {'), 'falls back to JSON');
  assert.ok(odd.length < 180, 'clipped');
});

test('resultDigest flattens whitespace and clamps; long output must not flood the trail', () => {
  const d = resultDigest('line one\nline two   ' + 'x'.repeat(500));
  assert.ok(!d.includes('\n'), 'flattened to one row');
  assert.ok(d.length <= 221, 'clamped');
  assert.equal(resultDigest(undefined), '');
  assert.equal(resultDigest({ ok: true }), '{"ok":true}');
  assert.equal(resultDigest('Error: not found'), 'Error: not found', 'errors survive intact');
});

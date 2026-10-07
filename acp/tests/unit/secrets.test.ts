// Regression tests for issue #2 — F6: setCredential rebuilt secrets.env from a filter that
// dropped every comment and blank line. Pure file I/O against an isolated state dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'acp-secrets-'));
process.env.ACP_STATE_DIR = tmp;

const { setCredential, getCredential, describeCredential, SECRETS_FILE, storedNames } =
  await import('../../src/config/secrets.ts');

const read = () => readFileSync(SECRETS_FILE, 'utf8');

test('F6: comments and blank lines survive a write', () => {
  writeFileSync(SECRETS_FILE, '# my notes\n\nFOO=1\n', 'utf8');
  setCredential('BAR', '2');
  const out = read();
  assert.match(out, /# my notes/, 'comment must be preserved');
  assert.match(out, /FOO=1/, 'unrelated key must be preserved');
  assert.match(out, /BAR=2/, 'new key must be written');
  assert.ok(out.includes('\n\n'), 'blank line must be preserved');
});

test('F6: updating an existing key preserves order and comments', () => {
  writeFileSync(SECRETS_FILE, '# header\nA=1\nB=2\n', 'utf8');
  setCredential('A', '9');
  const out = read();
  assert.match(out, /# header/);
  assert.match(out, /A=9/);
  assert.ok(!out.includes('A=1'), 'old value must be replaced');
  assert.match(out, /B=2/, 'the other key must be untouched');
  assert.ok(out.indexOf('A=9') < out.indexOf('B=2'), 'position must be preserved');
});

test('F6: deleting a key keeps comments and removes only that key', () => {
  writeFileSync(SECRETS_FILE, '# header\nA=1\nB=2\n', 'utf8');
  setCredential('A', '');
  const out = read();
  assert.match(out, /# header/);
  assert.ok(!/^A=/m.test(out), 'A must be gone');
  assert.match(out, /B=2/);
  assert.deepEqual(storedNames(), ['B']);
});

test('values are readable but never listed', () => {
  writeFileSync(SECRETS_FILE, 'FOO=secret-value\n', 'utf8');
  assert.equal(getCredential('FOO')?.value, 'secret-value');
  assert.equal(describeCredential('FOO').configured, true);
  assert.ok(!JSON.stringify(describeCredential('FOO')).includes('secret-value'), 'status must not leak the value');
});

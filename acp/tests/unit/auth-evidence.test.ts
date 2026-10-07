// Regression tests for issue #6 — credential evidence.
//
// The two false positives being locked down here:
//   1. `~/.claude` (a DIRECTORY, created by any adapter run) was treated as a credential.
//   2. A successful ACP handshake was recorded as `authenticated`, so /api/status claimed
//      authentication on a machine with no credentials at all.
// Every case uses a temporary HOME, so nothing touches the real one.
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authEvidence, nativeAuthEvidence } from '../../src/config/auth-evidence.ts';

const emptyHome = () => mkdtempSync(join(tmpdir(), 'acp-home-'));

test('F6-native: a claude DIRECTORY is not credential evidence (issue #6)', () => {
  const home = emptyHome();
  // Exactly the state the reporter's machine was in: sessions/ and projects/ exist, no file.
  mkdirSync(join(home, '.claude', 'sessions'), { recursive: true });
  mkdirSync(join(home, '.claude', 'projects'), { recursive: true });
  const r = nativeAuthEvidence('claude', home);
  assert.notEqual(r.present, true, 'a directory must never be read as a credential');
  // macOS may keep it in the Keychain, so 'unknown' is acceptable there; elsewhere 'absent'.
  assert.equal(r.present, process.platform === 'darwin' ? 'unknown' : false);
});

test('F6-native: the claude credentials FILE is evidence', () => {
  const home = emptyHome();
  mkdirSync(join(home, '.claude'), { recursive: true });
  writeFileSync(join(home, '.claude', '.credentials.json'), '{"x":1}');
  const r = nativeAuthEvidence('claude', home);
  assert.equal(r.present, true);
  assert.match(r.detail, /\.credentials\.json/);
});

test('F6-native: codex/dsh use their real credential files', () => {
  const home = emptyHome();
  assert.equal(nativeAuthEvidence('codex', home).present, false);
  assert.equal(nativeAuthEvidence('dsh', home).present, false);
  mkdirSync(join(home, '.codex'), { recursive: true });
  writeFileSync(join(home, '.codex', 'auth.json'), '{}');
  assert.equal(nativeAuthEvidence('codex', home).present, true);
  mkdirSync(join(home, '.dsh'), { recursive: true });
  writeFileSync(join(home, '.dsh', '.credentials.yaml'), 'k: v');
  assert.equal(nativeAuthEvidence('dsh', home).present, true);
});

test('F6-native: opaque stores report unknown, never a guess', () => {
  const home = emptyHome();
  // opencode keeps its account in its own sqlite store — we cannot decide, so we say so.
  assert.equal(nativeAuthEvidence('opencode', home).present, 'unknown');
  // A custom agent: we have no idea where it keeps credentials.
  assert.equal(nativeAuthEvidence('my-custom-agent', home).present, 'unknown');
});

test('F6-evidence: env/secrets credential yields present with its source', () => {
  const home = emptyHome();
  const KEY = 'ACP_TEST_EVIDENCE_KEY';
  delete process.env[KEY];
  assert.equal(authEvidence('codex', KEY, home).state, 'absent', 'no env, no file -> absent');

  process.env[KEY] = 'sk-test';
  const r = authEvidence('codex', KEY, home);
  assert.equal(r.state, 'present');
  assert.deepEqual(r.sources, [`env:${KEY}`]);
  delete process.env[KEY];
});

test('F6-evidence: absent only when we positively looked and found nothing', () => {
  const home = emptyHome();
  assert.equal(authEvidence('codex', null, home).state, 'absent');
  // opencode has no inspectable channel -> unknown, so the Router falls back to declared facts
  // instead of excluding a working agent.
  const oc = authEvidence('opencode', null, home);
  assert.equal(oc.state, 'unknown');
  assert.ok(oc.note, 'unknown must explain itself');
});

test('F6-evidence: native login alone is enough for present (the reverse false-negative)', () => {
  // The old UI reported codex as "✕ 未配置" on a machine whose ~/.codex/auth.json existed but
  // where OPENAI_API_KEY was unset. Evidence must count the native login.
  const home = emptyHome();
  mkdirSync(join(home, '.codex'), { recursive: true });
  writeFileSync(join(home, '.codex', 'auth.json'), '{}');
  const r = authEvidence('codex', 'ACP_DEFINITELY_UNSET_KEY', home);
  assert.equal(r.state, 'present');
  assert.equal(r.sources.length, 1);
  assert.match(r.sources[0], /auth\.json/);
});

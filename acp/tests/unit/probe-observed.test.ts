// Regression tests for issue #2 — F2: the capability probe wrote observations into the
// git-tracked capability-matrix.json (and overwrote `command` with a bare executable path,
// even when the probe failed). Observed facts must land in the state dir instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'acp-probe-'));
const declaredPath = join(tmp, 'matrix.json');
const observedPath = join(tmp, 'observed.json');
process.env.ACP_MATRIX_FILE = declaredPath;
process.env.ACP_OBSERVED_FILE = observedPath;

// A declared matrix with a command line we must NOT clobber.
const declared = {
  agents: {
    dsh: { transport: 'json-process', command: 'node /opt/dsh/lib/bin.js --profile headless', auth: { status: 'not-configured' } },
  },
};
writeFileSync(declaredPath, JSON.stringify(declared, null, 2), 'utf8');
const declaredBefore = readFileSync(declaredPath, 'utf8');

const { probeAgent } = await import('../../src/config/probe.ts');

test('F2: a json-process probe never mutates the declared matrix', async () => {
  const r = await probeAgent('dsh', {
    transport: 'json-process',
    command: process.execPath,
    args: ['-e', 'process.exit(0)'],   // `--help` is appended by the probe and ignored
  });
  assert.equal(r.ok, true, `probe should succeed: ${r.error ?? r.detail ?? ''}`);
  assert.equal(readFileSync(declaredPath, 'utf8'), declaredBefore, 'the tracked matrix must be byte-identical');
});

test('F2: observed facts go to the state file, with the full command line preserved', () => {
  const observed = JSON.parse(readFileSync(observedPath, 'utf8'));
  assert.ok(observed.agents.dsh, 'observed entry must exist');
  const cmd = observed.agents.dsh.command as string;
  assert.ok(cmd.includes('-e'), `argv must be preserved, got: ${cmd}`);
  // issue #6: a probe records `reachable`, NOT `authenticated` — initialize + session/new do
  // not validate credentials, so the old wording let a probe rubber-stamp authentication.
  assert.match(observed.agents.dsh.auth.status, /^reachable/);
  assert.doesNotMatch(observed.agents.dsh.auth.status, /authenticated/);
});

test('F2: a failed probe records no command', async () => {
  const before = JSON.parse(readFileSync(observedPath, 'utf8'));
  const r = await probeAgent('broken', {
    transport: 'json-process',
    command: 'definitely-not-a-real-binary-xyz',   // spawn failure -> probe failure
  });
  assert.equal(r.ok, false);
  const after = JSON.parse(readFileSync(observedPath, 'utf8'));
  assert.ok(!after.agents.broken?.command, 'a failed probe must not record a command');
  assert.equal(JSON.stringify(before.agents.dsh.command), JSON.stringify(after.agents.dsh.command));
});

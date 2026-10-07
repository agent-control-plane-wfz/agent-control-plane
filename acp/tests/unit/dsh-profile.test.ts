// Regression tests for issue #9 — the dsh run form must not be a hard-coded literal.
//
// Two things are locked down:
//   1. the argv contract (so "--profile headless" cannot silently come back, and a configured
//      profile actually reaches argv);
//   2. the precedence: user config > DSH_PROFILE > code default.
// Nothing is spawned here — dshArgv() is pure, so this costs no model calls.
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'acp-dsh-profile-'));
process.env.ACP_STATE_DIR = tmp;
process.env.WORKSPACE_DIR = mkdtempSync(join(tmpdir(), 'acp-ws-'));
process.env.DSH_BIN = join(tmp, 'fake-bin.js');       // only used to build strings
process.env.DSH_PROFILE = 'web';                       // layer ② for the precedence test

const { dshArgv, assertProfileName, DEFAULT_DSH_PROFILE, DshDriver } = await import('../../src/drivers/dsh-driver.ts');
const { getMerged, saveSettings } = await import('../../src/config/settings.ts');

test('F9: the default profile is headless and appears in argv (no literal left in run())', () => {
  const argv = dshArgv({ task: 'hi' });
  assert.deepEqual(argv, [process.env.DSH_BIN, '--profile', 'headless', '--json', 'hi']);
  assert.equal(DEFAULT_DSH_PROFILE, 'headless');
  // The driver must build argv through dshArgv rather than re-hardcoding the flag.
  const src = String(DshDriver.run);
  assert.ok(!/--profile[\s\S]{0,20}headless/.test(src), 'run() must not hard-code the profile again');
});

test('F9: a configured profile changes the spawned argv', () => {
  assert.deepEqual(dshArgv({ profile: 'web', task: 't' }),
    [process.env.DSH_BIN, '--profile', 'web', '--json', 't']);
});

test('F9: session resume keeps its own flag and ordering', () => {
  assert.deepEqual(dshArgv({ profile: 'headless', sessionId: 'session-abc', task: 't' }),
    [process.env.DSH_BIN, '--profile', 'headless', '--json', '--session-id', 'session-abc', 't']);
});

test('F9: a malformed profile is refused instead of being passed through', () => {
  for (const bad of ['', 'has space', '../etc', 'a/b', 'a\\b', '-x', '--json', '--profile=x']) {
    assert.throws(() => assertProfileName(bad), /invalid dsh profile name/, `${JSON.stringify(bad)} must be refused`);
    assert.throws(() => dshArgv({ profile: bad }), /invalid dsh profile name/);
  }
  for (const ok of ['headless', 'desktop', 'web', 'my_profile-2']) assertProfileName(ok);
});

test('F9: precedence is user config > DSH_PROFILE > code default', () => {
  // No user config: the environment wins over the built-in default.
  assert.equal(getMerged().agents.dsh.profile, 'web', 'DSH_PROFILE overrides the code default');
  // A value saved in the console wins over the environment.
  saveSettings({ agents: { dsh: { profile: 'headless' } } });
  assert.equal(getMerged().agents.dsh.profile, 'headless', 'user config overrides DSH_PROFILE');
});

test('F9: the settings validator refuses a conflicting --profile in args', () => {
  assert.throws(() => saveSettings({ agents: { dsh: { args: ['bin.js', '--profile', 'web'] } } }), /不要在参数里写 --profile/);
  assert.throws(() => saveSettings({ agents: { dsh: { args: ['bin.js', '--profile=web'] } } }), /不要在参数里写 --profile/);
  assert.throws(() => saveSettings({ agents: { dsh: { profile: 'not a profile' } } }), /profile/);
  assert.throws(() => saveSettings({ agents: { dsh: { profile: '-nope' } } }), /profile/);
});

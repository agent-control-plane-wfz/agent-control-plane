// Regression tests for issue #10 — configurable review-team slots.
//
// The load-bearing property: a pinned reviewer that shares the implementer's vendor (or whose
// vendor is unknown) must be REFUSED, and it must happen BEFORE anything is dispatched — after
// the implementer has run, the error would arrive having already spent quota.
//
// Every assertion here stops at pre-flight, so nothing is spawned and no model is called.
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'acp-team-'));
process.env.ACP_STATE_DIR = tmp;
process.env.WORKSPACE_DIR = mkdtempSync(join(tmpdir(), 'acp-ws-'));

// Fixtures: a1 and a2 run the SAME vendor; a3's vendor is unknown (fail-closed case).
const agents = {
  a1: { transport: 'acp', auth: { status: 'authenticated' } },
  a2: { transport: 'acp', auth: { status: 'authenticated' } },
  a3: { transport: 'acp', auth: { status: 'authenticated' } },
};
const models = {
  models: {
    'a1/x': { vendor: 'alpha', tier: 'fast', traits: [], via: 'a1' },
    'a2/y': { vendor: 'alpha', tier: 'fast', traits: [], via: 'a2' },
    'a3/z': { vendor: 'unknown', tier: 'fast', traits: [], via: 'a3' },
  },
  agentDefaults: { a1: { model: 'x' }, a2: { model: 'y' }, a3: { model: 'z' } },
};
const matrixPath = join(tmp, 'matrix.json');
writeFileSync(matrixPath, JSON.stringify({ agents }), 'utf8');
writeFileSync(join(tmp, 'capability-observed.json'), JSON.stringify({ agents: {} }), 'utf8');
process.env.ACP_MATRIX_FILE = matrixPath;
// The DECLARED model table lives in the repo; the per-machine overlay is the documented way to
// inject fixture vendors, and Registry merges declared-then-observed.
writeFileSync(join(tmp, 'models-observed.json'), JSON.stringify(models), 'utf8');
process.env.ACP_MODELS_OBSERVED_FILE = join(tmp, 'models-observed.json');

// The fixture agents must also exist in the SETTINGS layer (the registry alone is not enough) and
// be confirmed, otherwise issue #7's consent gate refuses them before the team rule is reached.
writeFileSync(join(tmp, 'control-plane-config.json'), JSON.stringify({
  agents: {
    a1: { confirmed: true, transport: 'acp' },
    a2: { confirmed: true, transport: 'acp' },
    a3: { confirmed: true, transport: 'acp' },
  },
  setup: { completedAt: '2026-10-07T00:00:00.000Z' },
}), 'utf8');

const { resolveTeam, heteroReview } = await import('../../src/review/review.ts');
const { ControlPlane } = await import('../../src/control/plane.ts');
const { saveSettings, getMerged, resetSettings } = await import('../../src/config/settings.ts');

const plane = new ControlPlane();
const cwd = tmp;

test('F10: an unset team is all-auto (today\'s behaviour, no regression)', () => {
  assert.deepEqual(resolveTeam(undefined), { implementer: 'auto', reviewer: 'auto', arbiter: 'auto' });
  assert.deepEqual(resolveTeam({ reviewer: 'a2' }), { implementer: 'auto', reviewer: 'a2', arbiter: 'auto' });
});

test('F10: an unknown template name fails, listing what exists', () => {
  saveSettings({ teams: { strict: { implementer: 'a1', reviewer: 'a2' } } });
  assert.throws(() => resolveTeam('nope'), /unknown team template: nope.*strict/s);
  assert.deepEqual(resolveTeam('strict'), { implementer: 'a1', reviewer: 'a2', arbiter: 'auto' });
});

test('F10: a same-vendor reviewer is refused BEFORE anything is dispatched', async () => {
  // a1 and a2 are both vendor 'alpha'.
  await assert.rejects(
    () => heteroReview(plane, { task: 'x', cwd, team: { implementer: 'a1', reviewer: 'a2' } }),
    /实际厂商相同|same vendor|alpha/,
  );
});

test('F10: a reviewer whose vendor is unknown is refused (fail-closed)', async () => {
  await assert.rejects(
    () => heteroReview(plane, { task: 'x', cwd, team: { implementer: 'a1', reviewer: 'a3' } }),
    /unknown/,
  );
});

test('F10: an arbiter must differ from both parties', async () => {
  // a1/a2 are alpha and a3 is unknown, so no valid third vendor exists in this fixture — the
  // assertion is that a pinned arbiter is CHECKED (the error names the arbiter rule or the
  // earlier reviewer rule), never silently accepted.
  await assert.rejects(
    () => heteroReview(plane, { task: 'x', cwd, team: { implementer: 'a1', reviewer: 'a2', arbiter: 'a3' } }),
    /实际厂商相同|unknown/,
  );
});

test('F10: the team rule is what refuses — not the consent gate behind it', async () => {
  const err = await heteroReview(plane, { task: 'x', cwd, team: { implementer: 'a1', reviewer: 'a2' } })
    .then(() => '', (e: any) => String(e?.message ?? e));
  assert.match(err, /实际厂商相同/, 'the refusal must come from the heterogeneity rule');
  assert.ok(!/尚未确认/.test(err), 'the slots were confirmed, so consent must not be the reason');
});

test('F10: slots must point at a confirmed agent (issue #7 gate applies to teams too)', async () => {
  saveSettings({ agents: { a2: { confirmed: false } }, setup: { completedAt: 'x' } });
  await assert.rejects(
    () => heteroReview(plane, { task: 'x', cwd, team: { implementer: 'a1', reviewer: 'a2' } }),
    /尚未确认启用/,
  );
  saveSettings({ agents: { a2: { confirmed: true } } });
  assert.equal(getMerged().agents.a2.confirmed, true);
});

test('F10: team validation and reset', () => {
  assert.throws(() => saveSettings({ teams: { bad: { reviewer: 'not a valid id' } } }), /teams\.bad\.reviewer/);
  assert.throws(() => saveSettings({ teams: { 'bad name': { reviewer: 'auto' } } }), /模板名非法/);
  saveSettings({ teams: { t1: { implementer: 'a1' }, t2: { reviewer: 'a2' } } });
  resetSettings('teams', 't1');
  const teams = getMerged().teams ?? {};
  assert.equal(teams.t1, undefined, 'only the named template is removed');
  assert.deepEqual(teams.t2, { reviewer: 'a2' });
});

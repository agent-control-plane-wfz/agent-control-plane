// Unit tests: capability registry LOGIC, driven by fixtures rather than the checked-in tables.
//
// Issue #6: this file used to assert machine-bound facts — `actualVendor('claude') === 'deepseek'`
// is true only where Claude Code has been remapped to a DeepSeek endpoint. Such a test "passes"
// on every machine because it reads the same committed file, while its meaning holds on exactly
// one of them. Fixtures now pin the logic; the real tables get structural checks only.
//
// Also covers the #1 regression (the `authenticated` flag must invert requiresAuth) and the
// issue #6 rule that a probe's `reachable` verdict is never an authentication answer.
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Registry, type AuthEvidenceState } from '../../src/registry/registry.ts';

const root = mkdtempSync(join(tmpdir(), 'acp-reg-'));

function fixture(opts: { matrix: any; models: any; modelsObserved?: any }): Registry {
  const d = mkdtempSync(join(root, 'case-'));
  const write = (name: string, v: any) => {
    const p = join(d, name);
    writeFileSync(p, JSON.stringify(v), 'utf8');
    return p;
  };
  return new Registry(
    write('matrix.json', opts.matrix),
    write('models.json', opts.models),
    write('observed.json', { agents: {} }),
    opts.modelsObserved ? write('models-observed.json', opts.modelsObserved) : join(d, 'no-such-file.json'),
  );
}

const agent = (status?: string) => ({ transport: 'acp', ...(status ? { auth: { status } } : {}) });
const models = (m: Record<string, any>, defaults: Record<string, any> = {}) => ({ models: m, agentDefaults: defaults });

test('requiresAuth is EVIDENCE-ONLY: no declared status can answer it (issue #6)', () => {
  const reg = fixture({
    matrix: {
      agents: {
        previouslyAuthenticated: agent('authenticated (phase 0)'),
        previouslyMissing: agent('not-configured'),
        probed: agent('reachable (probe 2026-10-07)'),
        unreachable: agent('unreachable (probe 2026-10-07)'),
        silent: agent(),
      },
    },
    models: models({}),
  });
  // With no evidence channel injected, every one of them is 'unknown' — in particular a declared
  // `authenticated` must NOT be read as "this machine can authenticate", and a probe handshake
  // must not either. The declared field is documentation, not a routing input.
  for (const id of ['previouslyAuthenticated', 'previouslyMissing', 'probed', 'unreachable', 'silent']) {
    assert.equal(reg.requiresAuth(id as any), 'unknown', `${id}: declared status is not an auth answer`);
  }
});

test('requiresAuth maps injected credential evidence', () => {
  const reg = fixture({
    matrix: { agents: { stale: agent('authenticated (phase 0)'), looksMissing: agent('not-configured') } },
    models: models({}),
  });
  const ev: Record<string, AuthEvidenceState> = { stale: 'absent', looksMissing: 'present' };
  reg.setAuthEvidence((id) => ev[id]);
  // The declared snapshot drifts in both directions; evidence decides.
  assert.equal(reg.requiresAuth('stale'), true, 'evidence absent beats a declared authenticated');
  assert.equal(reg.requiresAuth('looksMissing'), false, 'evidence present beats a stale not-configured');
  // Unknown evidence stays unknown so the Router keeps the agent (it only excludes on `true`).
  reg.setAuthEvidence(() => 'unknown');
  assert.equal(reg.requiresAuth('stale'), 'unknown');
});

test('actualVendor: declared table, then the per-machine overlay, else unknown', () => {
  const declared = models(
    { 'x/one': { vendor: 'alpha', tier: 'fast', traits: [], via: 'x' } },
    { x: { model: 'one' } },
  );
  assert.equal(fixture({ matrix: { agents: { x: agent() } }, models: declared }).actualVendor('x'), 'alpha');
  assert.equal(
    fixture({ matrix: { agents: { x: agent() } }, models: declared }).actualVendor('x', 'nope'),
    'unknown',
    'an unlisted model is never guessed',
  );

  const overlaid = fixture({
    matrix: { agents: { x: agent() } },
    models: declared,
    modelsObserved: { models: { 'x/one': { vendor: 'beta', tier: 'fast', traits: [], via: 'x' } } },
  });
  assert.equal(overlaid.actualVendor('x'), 'beta', 'the machine-local mapping must win');
});

test('agentsExcludingVendors is fail-closed on unknown vendors', () => {
  const reg = fixture({
    matrix: { agents: { a: agent(), u: agent(), g: agent(), cli: { transport: 'cli-process' } } },
    models: models(
      {
        'a/m': { vendor: 'alpha', tier: 'fast', traits: [], via: 'a' },
        'u/m': { vendor: 'unknown', tier: 'fast', traits: [], via: 'u' },
        'g/m': { vendor: 'gamma', tier: 'fast', traits: [], via: 'g' },
      },
      { a: { model: 'm' }, u: { model: 'm' }, g: { model: 'm' } },
    ),
  });
  assert.deepEqual(reg.agentsExcludingVendors(['alpha']), ['g']);
  assert.ok(!reg.agentsExcludingVendors(['alpha']).includes('u'), 'unknown vendor cannot satisfy exclusion');
});

test('statusList: one row per matrix agent, authenticated inverts requiresAuth (regression #1)', () => {
  const reg = new Registry();
  const list = reg.statusList();
  assert.equal(list.length, Object.keys(reg.matrix.agents).length, 'one entry per agent in the matrix');
  for (const a of list) {
    const needsAuth = reg.requiresAuth(a.agent);
    if (needsAuth === 'unknown') assert.equal(a.authenticated, 'unknown', `${a.agent}: unknown stays unknown`);
    else assert.equal(a.authenticated, !needsAuth, `${a.agent}: authenticated must invert requiresAuth()`);
    assert.ok(['acp', 'json-process', 'cli-process'].includes(a.transport));
    assert.ok(Array.isArray(a.models));
  }
});

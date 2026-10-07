// Regression tests for issue #11 — tier participates in routing, and named presets.
//
// The finding being fixed: `tier` existed on every model entry and NO code read it, so "use the
// cheap/fast model for this mechanical task" was unsayable. These tests pin the two mechanisms
// that make it usable, entirely at the routing layer — no model is ever called.
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'acp-tier-'));
process.env.ACP_STATE_DIR = tmp;
process.env.WORKSPACE_DIR = mkdtempSync(join(tmpdir(), 'acp-ws-'));

// Fixture: `alpha` has a cheap and a frontier model; `beta` has only a fast one.
const agents = {
  alpha: { transport: 'acp', auth: { status: 'authenticated' } },
  beta: { transport: 'acp', auth: { status: 'authenticated' } },
};
const models = {
  models: {
    'alpha/alpha-default': { vendor: 'v-alpha', tier: 'fast', traits: [], via: 'alpha' },
    'alpha/alpha-big': { vendor: 'v-big', tier: 'frontier', traits: [], via: 'alpha' },
    'beta/beta-only': { vendor: 'v-beta', tier: 'fast', traits: [], via: 'beta' },
  },
  agentDefaults: { alpha: { model: 'alpha-default' }, beta: { model: 'beta-only' } },
};
writeFileSync(join(tmp, 'matrix.json'), JSON.stringify({ agents }), 'utf8');
writeFileSync(join(tmp, 'capability-observed.json'), JSON.stringify({ agents: {} }), 'utf8');
writeFileSync(join(tmp, 'models-observed.json'), JSON.stringify(models), 'utf8');
writeFileSync(join(tmp, 'control-plane-config.json'), JSON.stringify({
  agents: { alpha: { confirmed: true }, beta: { confirmed: true } },
  setup: { completedAt: '2026-10-07T00:00:00.000Z' },
}), 'utf8');
process.env.ACP_MATRIX_FILE = join(tmp, 'matrix.json');
process.env.ACP_MODELS_OBSERVED_FILE = join(tmp, 'models-observed.json');

const { Registry } = await import('../../src/registry/registry.ts');
const { route } = await import('../../src/router/router.ts');
const { applyPreset, listPresets } = await import('../../src/config/presets.ts');
const { saveSettings } = await import('../../src/config/settings.ts');

const reg = new Registry();

test('F11: tier accessors read the table the old code ignored', () => {
  assert.deepEqual(reg.modelsByTier('alpha' as any, 'frontier'), ['alpha-big']);
  assert.deepEqual(reg.modelsByTier('alpha' as any, 'cheap'), [], 'no cheap model -> empty, not a guess');
  assert.equal(reg.modelTier('alpha' as any), 'fast');
  assert.equal(reg.modelTier('alpha' as any, 'alpha-big'), 'frontier');
  assert.equal(reg.modelTier('alpha' as any, 'nope'), undefined);
});

test('F11: a requested tier selects a model of that tier', () => {
  const d = route(reg, { agent: 'alpha' as any, tier: 'frontier' });
  assert.equal(d.model, 'alpha-big');
  assert.match(d.reason, /tier:frontier/);
});

test('F11: an unsatisfiable tier falls back to the default AND says so', () => {
  const d = route(reg, { agent: 'alpha' as any, tier: 'cheap' });
  assert.equal(d.model, 'alpha-default', 'the agent default is used rather than nothing');
  assert.match(d.reason, /未匹配/, 'the reason must admit the preference was not honoured');
});

test('F11: an explicit model beats the tier', () => {
  const d = route(reg, { agent: 'alpha' as any, model: 'alpha-default', tier: 'frontier' });
  assert.equal(d.model, 'alpha-default', 'an explicit choice is not overridden by a preference');
  assert.ok(!/tier:frontier ->/.test(d.reason), 'and it is not reported as a tier match');
});

test('F11: the builtin rules carry no tier, so defaults are unchanged', () => {
  const d = route(reg, { agent: 'alpha' as any });
  assert.equal(d.model, 'alpha-default');
  assert.ok(!/tier:/.test(d.reason));
});

test('F11: a user rule can carry a tier and it is honoured', () => {
  const d = route(reg, { taskType: 'quick' }, { quick: { agent: 'alpha', tier: 'frontier' } });
  assert.equal(d.agent, 'alpha');
  assert.equal(d.model, 'alpha-big');
});

test('F11: presets expand as defaults; explicit fields win; unknown names are errors', () => {
  saveSettings({ presets: { deep: { agent: 'alpha', model: 'alpha-big', effort: 'high' } } });
  assert.deepEqual(listPresets().deep, { agent: 'alpha', model: 'alpha-big', effort: 'high' });
  const expanded = applyPreset({ preset: 'deep' } as any, 'deep');
  assert.equal(expanded.agent, 'alpha');
  assert.equal(expanded.model, 'alpha-big');
  assert.equal((expanded as any).preset, undefined, 'the preset key itself is not a request field');
  // explicit wins
  const overridden = applyPreset({ preset: 'deep', model: 'alpha-default' } as any, 'deep');
  assert.equal(overridden.model, 'alpha-default');
  // unknown -> loud
  assert.throws(() => applyPreset({} as any, 'typo'), /unknown preset: typo.*deep/s);
  // no preset -> untouched
  assert.deepEqual(applyPreset({ agent: 'beta' } as any, undefined), { agent: 'beta' });
});

test('F11: preset validation refuses malformed shapes', () => {
  assert.throws(() => saveSettings({ presets: { bad: { taskType: 'nope' as any } } }), /taskType/);
  assert.throws(() => saveSettings({ presets: { bad: { model: '' } } }), /presets\.bad\.model/);
  assert.throws(() => saveSettings({ presets: { 'bad name': {} } }), /预设名非法/);
});

test('F11: the heterogeneity check uses the TIER-RESOLVED model, not the agent default', () => {
  // alpha's default model is vendor v-alpha, but its frontier model is v-big.
  // NOTE: this must go through a RULE, not an explicit agent hint — an explicit hint is a hard
  // constraint (B5) and skips the heterogeneity filter entirely, so asserting it there would pass
  // without exercising the fix at all.
  const req = { requirements: { differentVendorFrom: ['v-alpha'] } };
  const noTier = route(reg, { taskType: 'quick', ...req }, { quick: { agent: 'alpha' } });
  assert.equal(noTier.agent, 'beta', 'default model is v-alpha -> alpha is correctly excluded');
  const withTier = route(reg, { taskType: 'quick', tier: 'frontier', ...req }, { quick: { agent: 'alpha' } });
  assert.equal(withTier.agent, 'alpha', 'the frontier model is v-big, so alpha now qualifies');
  assert.equal(withTier.model, 'alpha-big');
});

test('F11: the tier resolution is exposed as structured fields, not only as prose', () => {
  const hit = route(reg, { agent: 'alpha' as any, tier: 'frontier' });
  assert.equal(hit.tierRequested, 'frontier');
  assert.equal(hit.tierMatched, true, 'callers must not have to parse `reason`');
  const miss = route(reg, { agent: 'alpha' as any, tier: 'cheap' });
  assert.equal(miss.tierRequested, 'cheap');
  assert.equal(miss.tierMatched, false, 'fell back to the agent default');
  assert.equal(miss.model, 'alpha-default');
  const none = route(reg, { agent: 'alpha' as any });
  assert.equal(none.tierRequested, undefined, 'absent when no tier was asked');
});

test('F11: patching one preset does not drop its sibling fields', () => {
  saveSettings({ presets: { deep: { agent: 'alpha', model: 'alpha-big', effort: 'high' } } });
  saveSettings({ presets: { deep: { effort: 'max' } } });
  const p = listPresets().deep;
  assert.equal(p.agent, 'alpha', 'sibling fields survive a partial patch');
  assert.equal(p.model, 'alpha-big');
  assert.equal(p.effort, 'max', 'and the patched field is updated');
});

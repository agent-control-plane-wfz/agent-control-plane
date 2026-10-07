// Unit tests: routing rules + heterogeneity constraint (fail-closed). Pure logic, no network.
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Registry } from '../../src/registry/registry.ts';
import { route } from '../../src/router/router.ts';

const reg = new Registry();

test('explicit agent hint is honored verbatim (hard constraint)', () => {
  const d = route(reg, { agent: 'codex' });
  assert.equal(d.agent, 'codex');
  assert.equal(d.reason, 'explicit agent hint');
  assert.equal(d.model, reg.defaultModel('codex'));
});

test('explicit unknown agent is an error, never a silent swap', () => {
  assert.throws(() => route(reg, { agent: 'nope' as any }), /unknown agent: nope/);
});

test('taskType rule picks its default agent', () => {
  assert.equal(route(reg, { taskType: 'quick' }).agent, 'opencode');
  assert.equal(route(reg, { taskType: 'review' }).agent, 'claude');
  assert.match(route(reg, { taskType: 'code' }).reason, /rule:code/);
});

test('differentVendorFrom skips agents whose ACTUAL vendor matches', () => {
  // claude adapter runs deepseek here, so excluding deepseek must skip it and land on codex.
  const d = route(reg, { requirements: { differentVendorFrom: ['deepseek'] } });
  assert.equal(d.agent, 'codex');
  assert.match(d.reason, /differentVendorFrom/);
  assert.ok(!d.fallbackChain.includes('claude'), 'deepseek-vendor agent must not be a fallback');
});

test('heterogeneity is FAIL-CLOSED: unknown vendor can never satisfy the constraint', () => {
  // codex=openai, claude=deepseek, dsh=deepseek, opencode=unknown -> nothing is left.
  assert.throws(
    () => route(reg, { requirements: { differentVendorFrom: ['openai', 'deepseek'] } }),
    /no viable agent available/,
  );
});

test('fallback chain preserves route order minus the picked agent', () => {
  const d = route(reg, { taskType: 'quick' });
  assert.equal(d.agent, 'opencode');
  assert.deepEqual(d.fallbackChain, ['codex', 'claude', 'dsh']);
});

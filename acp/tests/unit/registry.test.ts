// Unit tests: capability registry (reads the checked-in matrix/models — no network).
// Includes a regression test for the `authenticated` flag: requiresAuth() answers
// "does this agent NEED auth", so statusList() must INVERT it. Reporting it raw made every
// authenticated agent show up as unauthenticated in the web console.
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Registry } from '../../src/registry/registry.ts';

const reg = new Registry();

test('requiresAuth: matrix "authenticated" entries do not need auth', () => {
  assert.equal(reg.requiresAuth('opencode'), false);
  assert.equal(reg.requiresAuth('claude'), false);
  assert.equal(reg.requiresAuth('codex'), false);
  assert.equal(reg.requiresAuth('dsh'), false);
});

test('actualVendor: adapter name is not the vendor (claude adapter runs deepseek here)', () => {
  assert.equal(reg.actualVendor('claude'), 'deepseek');
  assert.equal(reg.actualVendor('codex'), 'openai');
  assert.equal(reg.actualVendor('dsh'), 'deepseek');
  assert.equal(reg.actualVendor('opencode'), 'unknown');
});

test('actualVendor: unlisted model falls back to unknown (never guessed)', () => {
  assert.equal(reg.actualVendor('codex', 'no-such-model'), 'unknown');
});

test('statusList: authenticated flag is NOT inverted (regression)', () => {
  const list = reg.statusList();
  // Count is derived from the matrix, not hard-coded: v3 added a custom agent entry.
  assert.equal(list.length, Object.keys(reg.matrix.agents).length, 'one entry per agent in the matrix');
  for (const a of list) {
    const needsAuth = reg.requiresAuth(a.agent);
    if (needsAuth === 'unknown') assert.equal(a.authenticated, 'unknown', `${a.agent}: unknown stays unknown`);
    else assert.equal(a.authenticated, !needsAuth, `${a.agent}: authenticated must invert requiresAuth()`);
  }
  assert.ok(list.some((a) => a.authenticated === true), 'at least one agent should read as authenticated');
});

test('statusList: carries transport, models and actual vendor note', () => {
  const claude = reg.statusList().find((a) => a.agent === 'claude');
  assert.ok(claude);
  assert.equal(claude.transport, 'acp');
  assert.equal(claude.actualVendorNote, 'deepseek');
  assert.ok(claude.models.length > 0);
});

test('agentsExcludingVendors: excludes matching and unknown-vendor agents', () => {
  const left = reg.agentsExcludingVendors(['deepseek']);
  assert.ok(!left.includes('claude'), 'claude runs deepseek -> excluded');
  assert.ok(!left.includes('dsh'), 'dsh runs deepseek -> excluded');
  assert.ok(left.includes('codex'), 'codex runs openai -> kept');
});

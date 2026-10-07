// Regression tests for issue #2 — F4: the daily cap used the UTC day and never rolled over
// in a long-running process. Pure logic with an injected clock; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'acp-budget-'));
process.env.ACP_BUDGET_DIR = tmp;

const { Budget, localDay } = await import('../../src/budget/budget.ts');

test('localDay uses local calendar fields, not the UTC date', () => {
  const d = new Date(2026, 9, 8, 0, 30);           // local 2026-10-08 00:30
  assert.equal(localDay(d), '2026-10-08');
  // In UTC+8 the UTC date of that instant is still 2026-10-07 — the old implementation.
  assert.match(localDay(d), /^\d{4}-\d{2}-\d{2}$/);
});

test('F4: the ledger rolls over at local midnight, with no restart', () => {
  let now = new Date(2026, 9, 7, 23, 30);          // local Oct 7, 23:30
  const b = new Budget({ dailyRequests: 1, now: () => now });

  b.checkRequest();                                 // allowed
  b.record({ input: 10, output: 5 }, 'dsh');
  assert.equal(b.stats().date, '2026-10-07');
  assert.equal(b.stats().requests, 1);
  assert.throws(() => b.checkRequest(), /cap reached/, 'cap must bite on the same day');

  now = new Date(2026, 9, 8, 0, 30);                // local Oct 8, 00:30 — two hours later
  assert.doesNotThrow(() => b.checkRequest(), 'a new local day must reset the cap without a restart');
  assert.equal(b.stats().date, '2026-10-08');
  assert.equal(b.stats().requests, 0, 'counters must be zero for the new day');
});

test('resetDay zeroes the counters for the current local day', () => {
  // A day no other test touches — the ledger dir is shared across this file.
  const now = new Date(2026, 11, 31, 12, 0);
  const b = new Budget({ dailyRequests: 5, now: () => now });
  b.record({ input: 1, output: 1 }, 'codex');
  assert.equal(b.stats().requests, 1);
  b.resetDay();
  assert.equal(b.stats().requests, 0);
  assert.equal(b.stats().date, '2026-12-31');
});

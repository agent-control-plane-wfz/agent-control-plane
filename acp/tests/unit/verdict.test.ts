// Unit tests: structured verdict contract (pure logic — no network, no credentials).
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractVerdict, verdictInstruction, VERDICT_RETRY_PROMPT } from '../../src/core/verdict.ts';

test('extractVerdict: bare JSON object', () => {
  const r = extractVerdict('{"conclusion":"done","risks":["r1","r2"],"recommendation":"approve","testsPassed":true}');
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.verdict.conclusion, 'done');
  assert.deepEqual(r.verdict.risks, ['r1', 'r2']);
  assert.equal(r.verdict.recommendation, 'approve');
  assert.equal(r.verdict.testsPassed, true);
});

test('extractVerdict: fenced json block wins over surrounding prose', () => {
  const text = 'Here is my analysis.\n```json\n{"conclusion":"ok","risks":[]}\n```\nDone.';
  const r = extractVerdict(text);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.verdict.conclusion, 'ok');
});

test('extractVerdict: balanced object inside prose without fences', () => {
  const text = 'analysis... {"conclusion":"ok","risks":["x"]} trailing words';
  const r = extractVerdict(text);
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.verdict.conclusion, 'ok');
});

test('extractVerdict: risks given as a string is coerced to a one-element array', () => {
  const r = extractVerdict('{"conclusion":"c","risks":"single risk"}');
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.verdict.risks, ['single risk']);
});

test('extractVerdict: missing risks yields an empty array (conclusion is the only required field)', () => {
  const r = extractVerdict('{"conclusion":"c"}');
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.deepEqual(r.verdict.risks, []);
});

test('extractVerdict: JSON without conclusion is rejected', () => {
  const r = extractVerdict('{"risks":["r"]}');
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.error, 'no parseable verdict JSON found');
  assert.equal(r.raw, '{"risks":["r"]}');
});

test('extractVerdict: empty reply is rejected with a distinct error', () => {
  const r = extractVerdict('   ');
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.equal(r.error, 'empty reply');
});

test('verdict prompt contract: instruction demands JSON only, retry prompt repeats it', () => {
  assert.match(verdictInstruction(), /OUTPUT REQUIREMENT/);
  assert.match(verdictInstruction(), /conclusion/);
  assert.match(VERDICT_RETRY_PROMPT('bad shape'), /bad shape/);
  assert.match(VERDICT_RETRY_PROMPT('bad shape'), /ONLY the JSON/);
});

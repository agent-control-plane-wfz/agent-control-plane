// Regression test for issue #2 — F8: /auth/i also matched "author", so a content-level
// failure was misread as a transport failure and retried on another vendor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isTransportError } from '../../src/core/transport-error.ts';

test('F8: "author" / "authority" are NOT auth failures', () => {
  assert.equal(isTransportError('the file author is missing'), false);
  assert.equal(isTransportError('authority check failed for this path'), false);
  assert.equal(isTransportError('authors list is empty'), false);
});

test('genuine transport/auth failures still qualify', () => {
  assert.equal(isTransportError('spawn failed (ENOENT)'), true);
  assert.equal(isTransportError('request timeout after 30000ms'), true);
  assert.equal(isTransportError('MODULE_NOT_FOUND'), true);
  assert.equal(isTransportError('unauthorized: invalid api key'), true);
  assert.equal(isTransportError('auth required before prompting'), true);
  assert.equal(isTransportError('missing credential for OPENAI_API_KEY'), true);
  assert.equal(isTransportError('ECONNREFUSED 127.0.0.1:3080'), true);
});

test('content-level failures are not retried', () => {
  assert.equal(isTransportError('the tests do not pass'), false);
  assert.equal(isTransportError('conclusion: the patch is wrong'), false);
  assert.equal(isTransportError(undefined), false);
  assert.equal(isTransportError(''), false);
});

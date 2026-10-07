// Unit tests: JsonRpcStdio must degrade a failed spawn into rejected requests.
// Regression guard for PR #1 (P0): without a ChildProcess 'error' listener, Node rethrows
// the ENOENT as an unhandled 'error' event and kills the host process — one bad job used
// to take down the whole control plane. Both trigger paths are covered here.
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JsonRpcStdio } from '../../src/core/jsonrpc.ts';

test('missing executable: request rejects, process survives', async () => {
  const rpc = new JsonRpcStdio('definitely-not-a-real-binary-xyz', [], process.cwd(), 'missing-binary');
  await assert.rejects(async () => { await rpc.request('initialize', {}, 5000); }, /spawn failed|ENOENT/);
  assert.equal(rpc.exited, true, 'client is marked exited');
});

test('missing cwd: request rejects, process survives', async () => {
  // The easiest real-world trigger: a task pointed at a directory that does not exist.
  const rpc = new JsonRpcStdio(process.execPath, ['-e', '0'], 'Z:\\no\\such\\dir\\at\\all', 'missing-cwd');
  await assert.rejects(async () => { await rpc.request('initialize', {}, 5000); }, /spawn failed|ENOENT/);
  assert.equal(rpc.exited, true);
});

test('a failed spawn rejects every pending request, not just the first', async () => {
  const rpc = new JsonRpcStdio('definitely-not-a-real-binary-abc', [], process.cwd(), 'multi-pending');
  const results = await Promise.allSettled([
    rpc.request('a', {}, 5000),
    rpc.request('b', {}, 5000),
    rpc.request('c', {}, 5000),
  ]);
  assert.equal(results.filter((r) => r.status === 'rejected').length, 3, 'all pending requests must reject');
});

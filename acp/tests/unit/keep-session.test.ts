// Regression tests for issue #2 — F1: `keepSession` was accepted and then ignored, so
// spawn_agent / send_agent / stop_agent could never work for ACP agents. Driven against a
// minimal stub ACP agent (tests/fixtures/stub-acp-agent.mjs) — no credentials, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const stub = join(here, '..', 'fixtures', 'stub-acp-agent.mjs');

const tmp = mkdtempSync(join(tmpdir(), 'acp-keep-'));
process.env.ACP_STATE_DIR = tmp;
process.env.ACP_BUDGET_DIR = tmp;
process.env.ACP_OBSERVED_FILE = join(tmp, 'capability-observed.json');

// A user-configured agent pointing at the stub, plus an observed entry so the Router sees
// it as registered + authenticated (exactly what a probe would have recorded).
writeFileSync(join(tmp, 'control-plane-config.json'), JSON.stringify({
  agents: { stub: { enabled: true, transport: 'acp', command: process.execPath, args: [stub] } },
}), 'utf8');
writeFileSync(join(tmp, 'capability-observed.json'), JSON.stringify({
  agents: { stub: { auth: { status: 'authenticated (probe test)' } } },
}), 'utf8');

const { ControlPlane } = await import('../../src/control/plane.ts');

test('keepSession: session survives ask(), send() continues it, stop() reclaims it', async () => {
  const plane = new ControlPlane();
  try {
    const r1 = await plane.ask({ agent: 'stub', task: 'hello', cwd: tmp, keepSession: true, timeoutMs: 30_000 });
    assert.equal(r1.ok, true, `first turn failed: ${r1.error ?? ''}`);
    assert.ok(r1.sessionId, 'a sessionId must be returned');
    assert.match(r1.text, /turns:1/);

    // F1: the kept session must still be registered — otherwise send() cannot find it.
    assert.ok(
      plane.listSessions().includes(`stub:${r1.sessionId}`),
      `kept session must remain registered, got ${JSON.stringify(plane.listSessions())}`,
    );

    const r2 = await plane.send('stub', r1.sessionId, 'again', 30_000);
    assert.equal(r2.ok, true, `follow-up failed: ${r2.error ?? ''}`);
    assert.match(r2.text, /turns:2/, 'the same session must have advanced to turn 2');

    const stopped = await plane.stop('stub', r1.sessionId);
    assert.equal(stopped.stopped, true, 'stop() must find and cancel a kept session');
    assert.ok(!plane.listSessions().includes(`stub:${r1.sessionId}`), 'stop() must reclaim the session');
  } finally {
    await plane.shutdown();
  }
});

test('default (keepSession off): session is torn down after ask()', async () => {
  const plane = new ControlPlane();
  try {
    const r = await plane.ask({ agent: 'stub', task: 'hi', cwd: tmp, timeoutMs: 30_000 });
    assert.equal(r.ok, true);
    assert.equal(plane.listSessions().length, 0, 'a non-kept session must not linger');
  } finally {
    await plane.shutdown();
  }
});

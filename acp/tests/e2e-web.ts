// E2E: web console — spawn the server as a child process, verify static page,
// /api/status, then one real dsh ask roundtrip through the HTTP API.
// Run: WORKSPACE_DIR=<workspace> DEEPSEEK_API_KEY=<key> node --experimental-strip-types tests/e2e-web.ts
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { confirmAllViaHttp } from './_setup-http.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const PORT = process.env.ACP_WEB_PORT ?? '7899';
const base = `http://127.0.0.1:${PORT}`;
let failed = false;

if (!process.env.WORKSPACE_DIR) {
  console.error('WORKSPACE_DIR is required (path to the node workspace holding adapter packages)');
  process.exit(1);
}

// Isolate every state file the server writes (job history, budget ledger, credentials,
// user config, probe observations) — otherwise an E2E run appends to the real deployment's
// state. This is the same class of pollution that issue #2 flagged on the probe side.
const STATE = process.env.ACP_TEST_STATE ?? mkdtempSync(join(tmpdir(), 'acp-web-e2e-'));

const child = spawn(process.execPath, ['--experimental-strip-types', 'src/web/server.ts'], {
  cwd: root,
  env: { ...process.env, ACP_WEB_PORT: PORT, ACP_STATE_DIR: STATE },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

async function until(fn: () => Promise<any>, timeoutMs: number, label: string) {
  const t0 = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* retry */ }
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 800));
  }
}

try {
  // 1) server up + static page
  // issue #7: nothing is routable until confirmed — act as the user.
  await until(async () => (await fetch(base)).status === 200, 20_000, 'server listen');
  const page = await (await fetch(base)).text();
  console.log('static page:', page.includes('Agent Control Plane') ? 'OK' : 'MISSING TITLE');
  if (!page.includes('Agent Control Plane')) failed = true;

  // 2) status
  const status: any = await (await fetch(`${base}/api/status`)).json();
  const names = (status.agents ?? []).map((a: any) => a.agent).sort().join(',');
  console.log('status agents:', names, '| budget keys:', Object.keys(status.budget ?? {}).length);
  if (!(status.agents ?? []).length) { console.error('FAIL: empty agents'); failed = true; }

  // 3) validation
  const bad = await fetch(`${base}/api/ask`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  console.log('validation (empty body):', bad.status === 400 ? 'OK (400)' : `UNEXPECTED ${bad.status}`);
  if (bad.status !== 400) failed = true;

  // 4) real dsh roundtrip via HTTP
  const sub: any = await (await fetch(`${base}/api/ask`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agent: 'dsh', task: '只输出两个字符：OK', cwd: root }),
  })).json();
  console.log('submitted job:', sub.id, sub.status);
  const job: any = await until(async () => {
    const j: any = await (await fetch(`${base}/api/jobs/${sub.id}`)).json();
    return j.status !== 'running' ? j : undefined;
  }, 180_000, 'dsh job completion');
  // This asserts the HTTP plumbing (submit → poll → result → events), not the model's
  // wording: a live model may answer with prose instead of the literal token, which is not
  // what this test is about. Exact-content assertions live on the more deterministic paths
  // (e2e-send / e2e-phase3).
  const text = job.result?.text ?? '';
  const ok = job.status === 'done' && job.result?.ok === true && text.trim().length > 0;
  console.log('dsh roundtrip:', ok ? `OK — "${text.slice(0, 60)}" in ${(job.result.durationMs / 1000).toFixed(1)}s` : `FAIL — ${JSON.stringify(job).slice(0, 400)}`);
  if (!ok) failed = true;
  // 5) live event stream captured (UI livelog data source)
  const evCount = (job.events ?? []).length;
  const hasText = (job.events ?? []).some((e: any) => e.kind === 'text');
  console.log(`events captured: ${evCount} (text events: ${hasText ? 'yes' : 'no'})`);
  if (!evCount || !hasText) { console.error('FAIL: no live events captured'); failed = true; }
} catch (e: any) {
  console.error('E2E error:', String(e?.message ?? e));
  failed = true;
} finally {
  child.kill();
  if (!process.env.ACP_TEST_STATE) { try { rmSync(STATE, { recursive: true, force: true }); } catch { /* tolerate */ } }
}

console.log(failed ? '\nWEB_E2E_FAIL' : '\nWEB_E2E_PASS');
process.exit(failed ? 1 : 0);

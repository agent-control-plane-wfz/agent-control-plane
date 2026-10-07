// E2E: settings center (P1) — runs the server against an ISOLATED ACP_STATE_DIR so the
// real user config / secrets are untouched. Verifies: settings merge, credential
// write-only seam (no value ever returned), disabled-agent fail-loud routing,
// and a real ACP capability probe (handshake only, no token cost).
// Run: WORKSPACE_DIR=<ws> node --experimental-strip-types tests/e2e-settings.ts
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const PORT = '7901';
const base = `http://127.0.0.1:${PORT}`;
const STATE = join(here, '.settings-state');
let failed = false;

if (!process.env.WORKSPACE_DIR) {
  console.error('WORKSPACE_DIR is required');
  process.exit(1);
}
rmSync(STATE, { recursive: true, force: true });
mkdirSync(STATE, { recursive: true });
// Probe observations must not pollute the checked-in matrix: give the child a scratch copy.
const SCRATCH_MATRIX = join(STATE, 'capability-matrix.json');
writeFileSync(SCRATCH_MATRIX, readFileSync(join(root, '..', 'registry', 'capability-matrix.json'), 'utf8'), 'utf8');

const child = spawn(process.execPath, ['--experimental-strip-types', 'src/web/server.ts'], {
  cwd: root,
  env: {
    ...process.env, ACP_WEB_PORT: PORT, ACP_STATE_DIR: STATE, ACP_MATRIX_FILE: SCRATCH_MATRIX,
    DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY ?? 'sk-test-env-placeholder',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

async function until(fn: () => Promise<any>, timeoutMs: number, label: string) {
  const t0 = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* retry */ }
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout: ${label}`);
    await new Promise((r) => setTimeout(r, 600));
  }
}
const j = (v: any) => JSON.stringify(v);
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? '✓' : '✕ FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed = true;
}

try {
  await until(async () => (await fetch(base)).status === 200, 20_000, 'server listen');

  // 1) merged settings expose the four builtins
  const s: any = await (await fetch(`${base}/api/settings`)).json();
  const ids = Object.keys(s.merged.agents || {}).sort();
  check('settings: 4 builtin agents', ['claude', 'codex', 'dsh', 'opencode'].every((x) => ids.includes(x)), ids.join(','));

  // 2) credential seam: status only, never values
  const creds: any = await (await fetch(`${base}/api/credentials`)).json();
  const ds = creds.credentials.find((c: any) => c.name === 'DEEPSEEK_API_KEY');
  check('credentials: DEEPSEEK_API_KEY configured', ds?.configured === true, `source=${ds?.source}`);
  check('credentials: no secret value leaked in response', !j(creds).includes('sk-b0a0') && !j(creds).includes('sk-test-env-placeholder'));

  // 3) write + delete a test credential (write-only seam)
  await fetch(`${base}/api/credentials/ACP_TEST_KEY`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: j({ value: 'test-secret-123' }) });
  const creds2: any = await (await fetch(`${base}/api/credentials`)).json();
  const tk = creds2.credentials.find((c: any) => c.name === 'ACP_TEST_KEY');
  check('credentials: ACP_TEST_KEY configured after PUT', tk?.configured === true && tk?.source === 'secrets.env');
  check('credentials: stored value not echoed', !j(creds2).includes('test-secret-123'));
  await fetch(`${base}/api/credentials/ACP_TEST_KEY`, { method: 'DELETE' });
  const creds3: any = await (await fetch(`${base}/api/credentials`)).json();
  const tk3 = creds3.credentials.find((c: any) => c.name === 'ACP_TEST_KEY');
  check('credentials: ACP_TEST_KEY removed after DELETE', !tk3 || tk3.configured === false);

  // 4) validation refuses garbage with 400
  const bad = await fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: j({ agents: { codex: { transport: 'bogus' } } }) });
  check('settings: invalid transport rejected (400)', bad.status === 400, `got ${bad.status}`);

  // 5) disable codex -> explicit ask fails loudly (no LLM call), then re-enable via reset
  await fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: j({ agents: { codex: { enabled: false } } }) });
  const rows: any = await (await fetch(`${base}/api/agents`)).json();
  const cx = rows.agents.find((a: any) => a.id === 'codex');
  check('agents: codex disabled', cx?.enabled === false && cx?.authState === 'disabled');
  const job: any = await (await fetch(`${base}/api/ask`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: j({ agent: 'codex', task: 'x', cwd: root }) })).json();
  const doneJob: any = await until(async () => {
    const jj: any = await (await fetch(`${base}/api/jobs/${job.id}`)).json();
    return jj.status !== 'running' ? jj : undefined;
  }, 30_000, 'disabled-agent ask to settle');
  const errMsg: string = doneJob?.error || doneJob?.result?.error || '';
  check('ask: explicit disabled agent fails loudly', /禁用/.test(errMsg), errMsg.slice(0, 80));
  await fetch(`${base}/api/settings/reset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: j({ section: 'agents', sub: 'codex' }) });
  const rows2: any = await (await fetch(`${base}/api/agents`)).json();
  check('agents: codex re-enabled after reset', rows2.agents.find((a: any) => a.id === 'codex')?.enabled === true);

  // 6) real capability probe on claude adapter (handshake only — no token cost)
  const probe: any = await (await fetch(`${base}/api/agents/claude/test`, { method: 'POST' })).json();
  check('probe: claude handshake', probe.ok === true && (probe.models?.length ?? 0) >= 1, `${(probe.durationMs / 1000).toFixed(1)}s, models=${(probe.models || []).length}, efforts=${(probe.efforts || []).length}`);

  // 7) P2: routing rule override takes effect (quick -> dsh), real roundtrip
  await fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: j({ routing: { rules: { quick: { agent: 'dsh' } } } }) });
  const s2: any = await (await fetch(`${base}/api/settings`)).json();
  check('routing: effectiveRouting reflects user rule', s2.effectiveRouting?.quick?.source === 'user' && s2.effectiveRouting?.quick?.agent === 'dsh');
  const qjob: any = await (await fetch(`${base}/api/ask`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: j({ taskType: 'quick', task: '只输出两个字符：OK', cwd: root }) })).json();
  const qdone: any = await until(async () => {
    const jj: any = await (await fetch(`${base}/api/jobs/${qjob.id}`)).json();
    return jj.status !== 'running' ? jj : undefined;
  }, 180_000, 'quick routing roundtrip');
  check('routing: quick task actually routed to dsh', qdone?.result?.agent === 'dsh' && qdone?.result?.ok === true, `agent=${qdone?.result?.agent}, ok=${qdone?.result?.ok}`);

  // 8) P2: cwd recorded into recentCwds after ask
  const s3: any = await (await fetch(`${base}/api/settings`)).json();
  check('workspace: cwd recorded into recentCwds', (s3.merged.workspace.recentCwds || []).includes(root));

  // 9) P2: budget reset wipes today's counters
  await fetch(`${base}/api/budget/reset`, { method: 'POST' });
  const st: any = await (await fetch(`${base}/api/status`)).json();
  check('budget: resetDay zeroes counters', (st.budget?.requests ?? 1) === 0, `requests=${st.budget?.requests}`);
  await fetch(`${base}/api/settings/reset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: j({ section: 'routing' }) });

  // 10) P3: custom agent onboarding (save -> appears -> probe -> remove)
  const cuArgs = [join(process.env.WORKSPACE_DIR!, 'node_modules', '@agentclientprotocol', 'claude-agent-acp', 'dist', 'index.js')];
  await fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: j({ agents: { mycustom: { enabled: true, transport: 'acp', command: process.execPath, args: cuArgs, credentialRef: 'ANTHROPIC_API_KEY' } } }) });
  const rows3: any = await (await fetch(`${base}/api/agents`)).json();
  check('custom: mycustom appears in agents', rows3.agents.some((a: any) => a.id === 'mycustom'));
  const cprobe: any = await (await fetch(`${base}/api/agents/mycustom/test`, { method: 'POST' })).json();
  check('custom: probe mycustom handshake', cprobe.ok === true, `${(cprobe.durationMs / 1000).toFixed(1)}s, models=${(cprobe.models || []).length}`);
  await fetch(`${base}/api/settings/reset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: j({ section: 'agents', sub: 'mycustom' }) });
  const rows4: any = await (await fetch(`${base}/api/agents`)).json();
  check('custom: mycustom removed after reset', !rows4.agents.some((a: any) => a.id === 'mycustom'));
} catch (e: any) {
  console.error('E2E error:', String(e?.message ?? e));
  failed = true;
} finally {
  child.kill();
  rmSync(STATE, { recursive: true, force: true });
}

console.log(failed ? '\nSETTINGS_E2E_FAIL' : '\nSETTINGS_E2E_PASS');
process.exit(failed ? 1 : 0);

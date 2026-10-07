// E2E for issue #6 — credential status must not be a false positive.
//
// Reproduces the reporter's machine: a HOME where `~/.claude/` exists (any adapter run creates
// it) but holds NO credential file, and no Anthropic env var. Before the fix the console showed a
// green dot and /api/status reported authenticated: true — including after pressing "probe",
// because a successful handshake was written as `authenticated`.
//
// Portable by construction: it drives everything through a synthetic HOME, so it asserts the same
// things on any machine (the real-home case is unit-tested in auth-evidence.test.ts).
// Run: node --experimental-strip-types tests/e2e-auth.ts
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import './_isolate-state.ts';   // isolate state dir before app modules load
import { confirmAllViaHttp } from './_setup-http.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const PORT = process.env.ACP_AUTH_TEST_PORT ?? '7902';
const base = `http://127.0.0.1:${PORT}`;

if (!process.env.WORKSPACE_DIR) {
  console.error('WORKSPACE_DIR is required (path to the node workspace holding adapter packages)');
  process.exit(1);
}

const STATE = mkdtempSync(join(tmpdir(), 'acp-auth-state-'));
const HOME = mkdtempSync(join(tmpdir(), 'acp-auth-home-'));
// The reporter's exact situation: the DIRECTORY exists (created by a previous adapter run),
// the credential file does not.
mkdirSync(join(HOME, '.claude', 'sessions'), { recursive: true });
mkdirSync(join(HOME, '.claude', 'projects'), { recursive: true });

let failed = false;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '✓' : '✕ FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed = true;
};

const child = spawn(process.execPath, ['--experimental-strip-types', 'src/web/server.ts'], {
  cwd: root,
  env: {
    ...process.env,
    ACP_WEB_PORT: PORT,
    ACP_STATE_DIR: STATE,
    USERPROFILE: HOME,   // Windows
    HOME,                // POSIX
    ANTHROPIC_API_KEY: '',
    OPENAI_API_KEY: '',
    DEEPSEEK_API_KEY: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

const j = (v: unknown) => JSON.stringify(v);
async function until<T>(fn: () => Promise<T | undefined>, timeoutMs: number, label: string): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* retry */ }
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

try {
  const agents = await until(async () => {
    const r = await fetch(`${base}/api/agents`);
    return r.ok ? (await r.json()) as any : undefined;
  }, 30_000, 'server readiness');

  // issue #7: this file tests the CREDENTIAL judgement, so the consent precondition has to be
  // satisfied first — otherwise the refusal would come from the wizard gate, not from evidence.
  await confirmAllViaHttp(base);

  // Re-read AFTER confirming, so the assertions below describe the state under test.
  const rows: any[] = ((await (await fetch(`${base}/api/agents`)).json()) as any).agents;
  const claude = rows.find((a) => a.id === 'claude');
  check('reporter scenario: claude row exists', !!claude);
  check('claude directory alone is NOT credential evidence', claude.nativeAuth.present !== true,
    `nativeAuth.present=${j(claude.nativeAuth.present)} (${claude.nativeAuth.detail})`);
  check('claude row is not green (authState !== ok)', claude.authState !== 'ok', `authState=${claude.authState}`);
  check('claude evidence is absent, not present', claude.evidence.state === 'absent', `state=${claude.evidence.state}`);

  const status = (await (await fetch(`${base}/api/status`)).json()) as any;
  const claudeStatus = status.agents.find((a: any) => a.agent === 'claude');
  check('/api/status does not claim claude is authenticated',
    claudeStatus.authenticated !== true, `authenticated=${j(claudeStatus.authenticated)}`);
  const falselyTrue = status.agents.filter((a: any) => a.authenticated === true);
  check('no agent claims authentication on a credential-free machine',
    falselyTrue.length === 0, falselyTrue.map((a: any) => a.agent).join(',') || 'none');

  // The rubber stamp: press "probe" and confirm nothing starts claiming authentication.
  const probe = await (await fetch(`${base}/api/agents/claude/test`, { method: 'POST' })).json() as any;
  console.log(`  (probe outcome: ok=${probe.ok} ${probe.ok ? probe.detail : probe.error})`);
  const after = (await (await fetch(`${base}/api/status`)).json()) as any;
  const claudeAfter = after.agents.find((a: any) => a.agent === 'claude');
  check('probe does not turn into an authentication stamp',
    claudeAfter.authenticated !== true, `authenticated=${j(claudeAfter.authenticated)} after probing`);

  // Reverse false-negative: a native login with NO env key must read as usable.
  mkdirSync(join(HOME, '.codex'), { recursive: true });
  writeFileSync(join(HOME, '.codex', 'auth.json'), '{}');
  const rows2 = (await (await fetch(`${base}/api/agents`)).json()) as any;
  const codex = rows2.agents.find((a: any) => a.id === 'codex');
  check('native login alone counts (codex: ~/.codex/auth.json, no env key)',
    codex.authState === 'ok' && codex.nativeAuth.present === true,
    `authState=${codex.authState} native=${j(codex.nativeAuth.present)} detail=${codex.nativeAuth.detail}`);

  // A positively-missing credential must reach the router as an error, not a silent swap.
  const job = await (await fetch(`${base}/api/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: j({ agent: 'claude', task: 'x', cwd: root }),
  })).json() as any;
  const settled = await until(async () => {
    const r = await fetch(`${base}/api/jobs/${job.id}`);
    const jj = await r.json() as any;
    return jj.status !== 'running' ? jj : undefined;
  }, 30_000, 'credential-less ask to settle');
  const errMsg: string = settled?.error || settled?.result?.error || '';
  check('explicitly requesting a credential-less agent fails loudly',
    /credentials/.test(errMsg), errMsg.slice(0, 100));
} catch (e: any) {
  console.error('E2E error:', String(e?.message ?? e));
  failed = true;
} finally {
  child.kill();
  try { rmSync(STATE, { recursive: true, force: true }); rmSync(HOME, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failed ? '\nAUTH_E2E: FAIL' : '\nAUTH_E2E: PASS');
process.exit(failed ? 1 : 0);

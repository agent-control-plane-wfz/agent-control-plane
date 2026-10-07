// E2E for issue #7 — the first-run wizard and the consent gate.
//
// Covers the five acceptance criteria. Routing is asserted through ControlPlane.route() rather
// than by dispatching prompts: route() is pure, so this file makes NO model calls at all (it is
// safe to run without spending anyone's quota).
//
// Run: WORKSPACE_DIR=<ws> node --experimental-strip-types tests/e2e-setup.ts
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import './_isolate-state.ts';   // isolate state dir before app modules load

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const PORT = process.env.ACP_SETUP_TEST_PORT ?? '7903';
const base = `http://127.0.0.1:${PORT}`;

if (!process.env.WORKSPACE_DIR) {
  console.error('WORKSPACE_DIR is required (path to the node workspace holding adapter packages)');
  process.exit(1);
}
// Present so dsh passes the credential gate in the routing assertions below — route() never
// contacts the provider, so this is not a real credential use.
process.env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || 'sk-setup-e2e-not-used';

const { ControlPlane } = await import('../src/control/plane.ts');
const { USER_CONFIG_FILE } = await import('../src/config/settings.ts');

let failed = false;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '✓' : '✕ FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed = true;
};
const j = (v: unknown) => JSON.stringify(v);

const plane = new ControlPlane();
const configExists = () => existsSync(USER_CONFIG_FILE);
const dropConfig = () => { if (configExists()) rmSync(USER_CONFIG_FILE); };

const child = spawn(process.execPath, ['--experimental-strip-types', 'src/web/server.ts'], {
  cwd: root,
  env: { ...process.env, ACP_WEB_PORT: PORT },
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

async function until<T>(fn: () => Promise<T | undefined>, timeoutMs: number, label: string): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* retry */ }
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 400));
  }
}
const getSetup = async () => (await (await fetch(`${base}/api/setup`)).json()) as any;
const postSetup = async (agents: unknown) => {
  const r = await fetch(`${base}/api/setup`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: j({ agents }),
  });
  return { status: r.status, body: (await r.json()) as any };
};

try {
  await until(async () => (await fetch(`${base}/api/setup`)).ok, 30_000, 'server readiness');

  // ---- acceptance 1: a fresh machine opens on the wizard; nothing is routable yet ----------
  dropConfig();
  const fresh = await getSetup();
  check('fresh machine: phase is pending', fresh.phase === 'pending', `phase=${fresh.phase}`);
  check('fresh machine: candidates listed', (fresh.candidates ?? []).length >= 4,
    (fresh.candidates ?? []).map((c: any) => `${c.id}${c.detected ? '(detected)' : ''}`).join(' '));
  check('fresh machine: nothing is confirmed', (fresh.candidates ?? []).every((c: any) => c.confirmed === false));

  let routedTo: string | undefined;
  try { routedTo = plane.route({ taskType: 'quick' }).agent; } catch { routedTo = undefined; }
  check('fresh machine: routing refuses (fail-loud, no silent pick)', routedTo === undefined, `route=${j(routedTo)}`);

  let askErr = '';
  try { await plane.ask({ task: 'x', cwd: root }); } catch (e: any) { askErr = String(e?.message ?? e); }
  check('fresh machine: headless/MCP ask explains how to proceed',
    /no agent has been confirmed/.test(askErr), askErr.slice(0, 110));

  // ---- acceptance 2: confirm one agent -> routing uses only that one -----------------------
  const posted = await postSetup({ dsh: { confirm: true }, claude: { confirm: false } });
  check('wizard: writes the answers (200)', posted.status === 200, `status=${posted.status} ${posted.body?.error ?? ''}`);
  const after = await getSetup();
  check('wizard: phase becomes done', after.phase === 'done', `phase=${after.phase}`);
  const byId = (v: any, id: string) => (v.candidates ?? []).find((c: any) => c.id === id);
  check('wizard: dsh is configured', byId(after, 'dsh')?.configuredNow === true);
  check('wizard: declined claude is recorded, not merely unmentioned',
    byId(after, 'claude')?.confirmed === false && byId(after, 'claude')?.configuredNow === false);

  const quick = plane.route({ taskType: 'quick' });   // the builtin rule says opencode
  check('routing: a quick task goes to the ONLY confirmed agent, not the rule default',
    quick.agent === 'dsh', `agent=${quick.agent} reason=${quick.reason}`);
  check('routing: unconfirmed agents are not in the fallback chain',
    !quick.fallbackChain.includes('opencode') && !quick.fallbackChain.includes('codex')
    && !quick.fallbackChain.includes('claude'), `chain=${j(quick.fallbackChain)}`);

  const explicit = await plane.ask({ agent: 'codex', task: 'x', cwd: root });
  check('routing: explicitly requesting an unconfirmed agent fails with instructions',
    explicit.ok === false && /尚未确认/.test(explicit.error ?? ''), (explicit.error ?? '').slice(0, 100));

  const refused = await postSetup({ codex: { confirm: true, args: 'nope' } });
  check('wizard: malformed input is refused (400)', refused.status === 400, `status=${refused.status}`);

  // ---- acceptance 3: a pre-existing config -> no wizard, behaviour unchanged ---------------
  dropConfig();
  writeFileSync(USER_CONFIG_FILE, JSON.stringify({ agents: {}, routing: {}, budget: {}, workspace: {} }), 'utf8');
  const legacy = await getSetup();
  check('legacy machine: wizard does NOT appear', legacy.phase === 'legacy', `phase=${legacy.phase}`);
  let legacyRoute = '';
  try { legacyRoute = plane.route({ taskType: 'quick' }).agent; } catch (e: any) { legacyRoute = `ERROR: ${e?.message}`; }
  check('legacy machine: builtin routing behaves exactly as before', legacyRoute === 'opencode', `agent=${legacyRoute}`);

  // ---- acceptance 4: re-running the wizard keeps confirmations ------------------------------
  dropConfig();
  await postSetup({ codex: { confirm: true } });
  const rerun = await (await fetch(`${base}/api/setup/rerun`, { method: 'POST' })).json() as any;
  check('re-run: the wizard opens again', rerun.phase === 'pending', `phase=${rerun.phase}`);
  check('re-run: the confirmation is kept (only the marker is cleared)',
    byId(rerun, 'codex')?.confirmed === true && byId(rerun, 'codex')?.configuredNow === true);

  // ---- acceptance 5: convenience is not lost when everything is picked ---------------------
  dropConfig();
  const all: Record<string, any> = {};
  for (const c of (await getSetup()).candidates) all[c.id] = { confirm: true };
  await postSetup(all);
  const full = plane.route({ taskType: 'quick' });
  check('all confirmed: the rule default applies again (no usability loss)',
    full.agent === 'opencode', `agent=${full.agent}`);
  const codes = plane.status().map((a: any) => `${a.agent}:${a.configured ? 'on' : 'off'}`);
  check('status exposes the consent flags to the console and the MCP status tool',
    codes.every((s: string) => s.endsWith(':on')), codes.join(' '));
} catch (e: any) {
  console.error('E2E error:', String(e?.message ?? e));
  failed = true;
} finally {
  child.kill();
  try { await plane.shutdown(); } catch { /* noop */ }
}

console.log(failed ? '\nSETUP_E2E: FAIL' : '\nSETUP_E2E: PASS');
process.exit(failed ? 1 : 0);

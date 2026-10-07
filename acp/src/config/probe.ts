// Capability probe (v3): verify an agent's command + credential by doing the cheapest
// real thing — for ACP: initialize + session/new (measured in Phase 0: no token cost);
// for json-process: binary presence + `--help` exit 0. On success, writes what was
// observed back into capability-matrix.json so the Registry and the Router see the
// CURRENT state (fixes the stale-auth silent-reroute class of bugs from v2 testing).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AcpDriver } from '../drivers/acp-driver.ts';
import { DshDriver, dshCommand, dshArgs } from '../drivers/dsh-driver.ts';
import { execFile } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
// Override with ACP_MATRIX_FILE so tests can probe against a scratch copy instead of
// writing observed facts into the checked-in matrix (PR #1 follow-up: test pollution).
const MATRIX_FILE = process.env.ACP_MATRIX_FILE ?? join(here, '..', '..', '..', 'registry', 'capability-matrix.json');

export interface ProbeResult {
  ok: boolean;
  agent: string;
  transport: string;
  durationMs: number;
  models?: string[];
  efforts?: string[];
  authMethods?: string[];
  detail?: string;
  error?: string;
}

function readMatrix(): any {
  return JSON.parse(readFileSync(MATRIX_FILE, 'utf8'));
}

function writeMatrixObserved(id: string, patch: { auth?: string; configOptions?: any; command?: string }): void {
  const m = readMatrix();
  m.agents[id] = m.agents[id] ?? { transport: 'acp' };
  if (patch.auth) m.agents[id].auth = { ...(m.agents[id].auth ?? {}), status: patch.auth };
  if (patch.configOptions) m.agents[id].configOptions_observed = patch.configOptions;
  if (patch.command) m.agents[id].command = patch.command;
  writeFileSync(MATRIX_FILE, JSON.stringify(m, null, 2), 'utf8');
}

/** Probe one agent using its merged settings. Handshake-only by default (no token cost). */
export async function probeAgent(id: string, cfg: { transport?: string; command?: string; args?: string[] },
  cwd = process.cwd()): Promise<ProbeResult> {
  const t0 = Date.now();
  const transport = cfg.transport ?? 'acp';
  try {
    if (transport === 'json-process') {
      // dsh-style: binary must exist; `--help` must exit 0. No LLM call.
      const binArg = (cfg.args ?? dshArgs()).find((a) => a.includes('bin.js') || a.endsWith('.js'));
      if (binArg && !existsSync(binArg)) {
        return { ok: false, agent: id, transport, durationMs: Date.now() - t0, error: `binary not found: ${binArg}` };
      }
      const cmd = cfg.command ?? dshCommand();
      const args = [...(cfg.args ?? dshArgs()), '--help'];
      const code = await new Promise<number>((resolve) => {
        const child = execFile(cmd, args, { windowsHide: true, timeout: 30_000 }, () => { /* ignore stderr */ });
        child.on('exit', (c) => resolve(c ?? 1));
        child.on('error', () => resolve(1));
      });
      const ok = code === 0;
      writeMatrixObserved(id, { auth: ok ? `authenticated (probe ${new Date().toISOString().slice(0, 10)})` : `not-configured (probe ${new Date().toISOString().slice(0, 10)})`, command: cmd });
      return { ok, agent: id, transport, durationMs: Date.now() - t0, detail: ok ? '二进制存在且 --help 正常退出' : `--help 退出码 ${code}` };
    }

    // ACP: initialize + session/new, read live configOptions.
    const driver = AcpDriver.from({ agent: id, command: cfg.command ?? 'node', args: cfg.args ?? [] });
    const rpc = await driver.connect(cwd);
    try {
      const session = await driver.newSession(rpc, cwd);
      const opts: any[] = session.configOptions ?? [];
      const modelOpt = opts.find((o) => o.id === 'model' || o.category === 'model');
      const effOpt = opts.find((o) => o.id === 'effort' || o.id === 'reasoning_effort' || o.category === 'thought_level');
      const models = modelOpt?.options?.map((o: any) => o.value) ?? [];
      const efforts = effOpt?.options?.map((o: any) => o.value) ?? [];
      const observed: Record<string, any> = {};
      for (const o of opts) {
        observed[o.id] = { category: o.category, currentValue: o.currentValue, options: o.options ?? [] };
      }
      writeMatrixObserved(id, {
        auth: `authenticated (probe ${new Date().toISOString().slice(0, 10)})`,
        configOptions: observed,
        command: `${cfg.command} ${(cfg.args ?? []).join(' ')}`.trim(),
      });
      return { ok: true, agent: id, transport, durationMs: Date.now() - t0, models, efforts, detail: `握手成功：${models.length} 模型 / ${efforts.length} 档位` };
    } finally {
      try { await rpc.close(); } catch { /* noop */ }
    }
  } catch (e: any) {
    const msg = String(e?.message ?? e).slice(0, 300);
    writeMatrixObserved(id, { auth: `not-configured (probe ${new Date().toISOString().slice(0, 10)})` });
    return { ok: false, agent: id, transport, durationMs: Date.now() - t0, error: msg };
  }
}

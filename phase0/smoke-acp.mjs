// ACP smoke client: spawn an ACP agent over stdio (ndjson JSON-RPC 2.0),
// run initialize -> session/new, dump everything for capability probing.
// Usage: node smoke-acp.mjs <label> <command> [args...]
// Env:   SMOKE_CWD  working dir passed to session/new (default: script dir)
//        LOG_OUT    path for full transcript log (default: <label>-log.txt)
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const [label, cmd, ...args] = process.argv.slice(2);
const cwd = process.env.SMOKE_CWD || here;
const logPath = process.env.LOG_OUT || join(here, `${label}-log.txt`);

const child = spawn(cmd, args, { cwd, windowsHide: true });
const rl = createInterface({ input: child.stdout });
const log = [];
const pending = new Map();

function send(obj) {
  const line = JSON.stringify(obj);
  log.push('>> ' + line);
  child.stdin.write(line + '\n');
}

rl.on('line', (line) => {
  log.push('<< ' + line);
  try {
    const m = JSON.parse(line);
    if (m.id !== undefined && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  } catch { /* non-JSON line */ }
});
child.stderr.on('data', (d) => log.push('[stderr] ' + d.toString().trim()));
child.on('exit', (code) => log.push(`[exit] code=${code}`));

function request(id, method, params, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting for ${method}`));
    }, timeoutMs);
    pending.set(id, (m) => { clearTimeout(t); resolve(m); });
    send({ jsonrpc: '2.0', id, method, params });
  });
}

const result = { label, cmd: [cmd, ...args].join(' '), cwd, steps: {} };

try {
  const init = await request(1, 'initialize', {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: false, writeTextFile: false },
      terminal: false,
    },
  });
  if (init.error) {
    result.steps.initialize = { ok: false, error: init.error };
  } else {
    result.steps.initialize = { ok: true, result: init.result };
    send({ jsonrpc: '2.0', method: 'initialized' }); // notification
    try {
      const sn = await request(2, 'session/new', { cwd, mcpServers: [] }, 20000);
      result.steps.sessionNew = sn.error
        ? { ok: false, error: sn.error }
        : { ok: true, result: sn.result };
    } catch (e) {
      result.steps.sessionNew = { ok: false, error: e.message };
    }
  }
} catch (e) {
  result.steps.initialize = { ok: false, error: e.message };
}

try { child.kill(); } catch { /* already gone */ }
await new Promise((r) => {
  if (child.exitCode !== null) return r();
  child.on('exit', r);
  setTimeout(r, 3000);
});

writeFileSync(logPath, log.join('\n'), 'utf8');
writeFileSync(join(here, `${label}-result.json`), JSON.stringify(result, null, 2), 'utf8');
console.log(`SMOKE_DONE ${label} initialize=${result.steps.initialize?.ok} sessionNew=${result.steps.sessionNew?.ok}`);

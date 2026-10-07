// MCP server smoke: initialize -> tools/list -> tools/call(status). No agent prompt involved.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// Keep the smoke test out of the real deployment state (job history, budget ledger, …).
if (!process.env.ACP_STATE_DIR) process.env.ACP_STATE_DIR = mkdtempSync(join(tmpdir(), 'acp-mcp-smoke-'));
const child = spawn(process.execPath, ['--experimental-strip-types', join(here, '..', 'src', 'mcp', 'server.ts')], { windowsHide: true });
const rl = createInterface({ input: child.stdout });
const pending = new Map();
let nextId = 1;

rl.on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
child.stderr.on('data', (d) => process.stderr.write('[srv] ' + d));

function rpc(method, params) {
  const id = nextId++;
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout ' + method)), 15000);
    pending.set(id, (m) => { clearTimeout(t); res(m); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
console.log('INITIALIZE:', JSON.stringify(init.result.serverInfo));
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

const tl = await rpc('tools/list', {});
console.log('TOOLS:', tl.result.tools.map((t) => t.name).join(', '));

const st = await rpc('tools/call', { name: 'status', arguments: {} });
console.log('STATUS:', st.result.content[0].text.slice(0, 400));

child.kill();
console.log('MCP_SMOKE_OK');

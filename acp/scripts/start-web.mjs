// One-click launcher for the ACP web console.
// Does three things, so nobody has to remember env vars again:
//   1. resolve WORKSPACE_DIR (explicit env wins; otherwise auto-probe common locations)
//   2. spawn src/web/server.ts with the managed Node
//   3. once the port answers, open the default browser
// Direct run:  node scripts/start-web.mjs
// Env knobs:   ACP_WEB_PORT (default 7777) | ACP_NO_OPEN=1 (do not open browser) | WORKSPACE_DIR
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));   // acp/scripts
const acpDir = resolve(here, '..');                     // acp
const repoDir = resolve(acpDir, '..');                  // repo root
const serverFile = join(acpDir, 'src', 'web', 'server.ts');
const PORT = Number(process.env.ACP_WEB_PORT ?? 7777);
const URL = `http://127.0.0.1:${PORT}`;
const NO_OPEN = process.env.ACP_NO_OPEN === '1';

function log(msg) { console.log(`[start-web] ${msg}`); }

// --- 1. WORKSPACE_DIR ---------------------------------------------------------------
// A valid workspace is a directory whose node_modules holds any harness adapter:
//   @agentclientprotocol/* (claude/codex adapters)  and/or  @deepseek-ai/dsh
function looksLikeWorkspace(dir) {
  if (!dir) return false;
  return existsSync(join(dir, 'node_modules', '@agentclientprotocol'))
      || existsSync(join(dir, 'node_modules', '@deepseek-ai', 'dsh'));
}

function probeCandidates() {
  const home = homedir();
  return [
    acpDir,                                                                  // self-contained: acp/node_modules (run `npm install` in acp/)
    process.env.APPDATA && join(process.env.APPDATA, 'npm'),                 // npm global prefix
    join(home, '.workbuddy', 'binaries', 'node', 'workspace'),               // managed node workspace
    repoDir,
  ].filter(Boolean);
}

let workspace = process.env.WORKSPACE_DIR || '';
let source = workspace ? 'env (WORKSPACE_DIR)' : '';
if (!looksLikeWorkspace(workspace)) {
  if (workspace) log(`WORKSPACE_DIR="${workspace}" has no harness adapters; probing alternatives...`);
  const found = probeCandidates().find(looksLikeWorkspace);
  if (found) { workspace = found; source = 'auto-detected'; }
  else { workspace = ''; source = 'none'; }   // empty -> server falls back to opencode-only
}

if (workspace) log(`WORKSPACE_DIR -> ${workspace}  (${source})`);
else log('WORKSPACE_DIR not found. The console will start with opencode only; set WORKSPACE_DIR or configure agents in the Settings page.');

// Show which harness adapters are actually present, so a half-installed workspace is obvious
// instead of surfacing later as a mysterious spawn failure (opencode comes from PATH, not here).
if (workspace) {
  const nm = join(workspace, 'node_modules');
  const adapters = [
    ['claude', '@agentclientprotocol/claude-agent-acp'],
    ['codex', '@agentclientprotocol/codex-acp'],
    ['dsh', '@deepseek-ai/dsh'],
  ];
  const present = adapters.filter(([, pkg]) => existsSync(join(nm, ...pkg.split('/')))).map(([n]) => n);
  const missing = adapters.map(([n]) => n).filter((n) => !present.includes(n));
  log(`adapters: ${present.length ? present.join(', ') : 'none'}   (+ opencode via PATH)`);
  if (missing.length) {
    log(`not installed: ${missing.join(', ')} — run \`npm install\` in acp/ for a self-contained setup,`
      + ' or point WORKSPACE_DIR at a workspace that has them.');
  }
}

// --- 2. spawn the server ------------------------------------------------------------
const env = { ...process.env, ACP_WEB_PORT: String(PORT) };
if (workspace) env.WORKSPACE_DIR = workspace;
delete env.ACP_NO_OPEN;

log(`starting server on ${URL} ...`);
const child = spawn(process.execPath, ['--experimental-strip-types', serverFile], {
  cwd: acpDir,
  env,
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) log(`server stopped (${signal})`);
  else if (code && code !== 0) log(`server exited with code ${code}`);
  process.exit(code ?? 0);
});
child.on('error', (err) => {
  log(`failed to start server: ${err.message}`);
  process.exit(1);
});

// --- 3. open the browser once the port is live --------------------------------------
const onSignal = () => { if (!child.killed) child.kill('SIGINT'); };
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);

function openBrowser(url) {
  try {
    let cmd, args;
    if (process.platform === 'win32') { cmd = 'cmd'; args = ['/c', 'start', '', url]; }
    else if (process.platform === 'darwin') { cmd = 'open'; args = [url]; }
    else { cmd = 'xdg-open'; args = [url]; }
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
    log(`opened browser: ${url}`);
  } catch (e) {
    log(`could not open browser automatically (${e.message}); open ${url} manually`);
  }
}

async function waitAndOpen(attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(URL, { signal: AbortSignal.timeout(1000) });
      if (res.ok) {
        if (NO_OPEN) log(`console ready at ${URL} (browser auto-open disabled)`);
        else openBrowser(URL);
        return;
      }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  log(`server did not answer within ~15s; open ${URL} manually if it is still starting.`);
}

if (NO_OPEN) log('ACP_NO_OPEN=1 -> will not open a browser');
void waitAndOpen();

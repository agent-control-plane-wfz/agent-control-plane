// One-click launcher for the ACP console.
// Does four things, so nobody has to remember env vars again:
//   1. resolve WORKSPACE_DIR (explicit env wins; otherwise auto-probe common locations)
//   2. if the port is already live, just open the window (double-click #2 must not spawn a twin)
//   3. otherwise spawn src/web/server.ts with the managed Node
//   4. once the port answers, open either the default browser, or — with --desktop — a chromeless
//      app window (Edge/Chrome --app), which is how the console is used as a desktop tool
// Direct run:  node scripts/start-web.mjs [--desktop]
// Env knobs:   ACP_WEB_PORT (default 7777) | ACP_NO_OPEN=1 (do not open anything) | ACP_DESKTOP=1
//              | WORKSPACE_DIR
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
const DESKTOP = process.env.ACP_DESKTOP === '1' || process.argv.includes('--desktop');

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

// --- 2. already running? then this double-click only opens the window -------------------
async function portLive() {
  try { const r = await fetch(URL, { signal: AbortSignal.timeout(800) }); return r.ok; } catch { return false; }
}

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

// Desktop mode: a chromeless app window — no tabs, no address bar, its own taskbar entry.
function findAppBrowser() {
  if (process.platform !== 'win32') return null;
  return [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ].find((p) => existsSync(p));
}
function openDesktop(url) {
  const exe = findAppBrowser();
  if (!exe) { log('no Edge/Chrome found for an app window; opening the default browser instead'); return openBrowser(url); }
  spawn(exe, [`--app=${url}`, '--window-size=1500,940', '--no-first-run'], { stdio: 'ignore', detached: true }).unref();
  log(`opened desktop window: ${url}`);
}
const open = (url) => (DESKTOP ? openDesktop(url) : openBrowser(url));

if (await portLive()) {
  log(`Control Plane is already running at ${URL}`);
  if (!NO_OPEN) open(URL);
  process.exit(0);
}

// --- 3. start the server -----------------------------------------------------------------
const env = { ...process.env, ACP_WEB_PORT: String(PORT) };
if (workspace) env.WORKSPACE_DIR = workspace;
delete env.ACP_NO_OPEN;

log(`starting server on ${URL} ...`);
let child = null;
if (DESKTOP) {
  // Desktop mode: the server outlives this launcher (there is no console window keeping it
  // alive); stop it with stop-desktop.cmd. The next double-click finds the port live above.
  const detached = spawn(process.execPath, ['--experimental-strip-types', serverFile], {
    cwd: acpDir, env, stdio: 'ignore', detached: true,
  });
  detached.unref();
  log('server started in the background');
} else {
  child = spawn(process.execPath, ['--experimental-strip-types', serverFile], {
    cwd: acpDir, env, stdio: 'inherit',
  });
  child.on('exit', (code, signal) => {
    if (signal) log(`server stopped (${signal})`);
    else if (code && code !== 0) log(`server exited with code ${code}`);
    process.exit(code ?? 0);
  });
  child.on('error', (err) => { log(`failed to start server: ${err.message}`); process.exit(1); });
  const onSignal = () => { if (!child.killed) child.kill('SIGINT'); };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
}

// --- 4. open the window once the port answers --------------------------------------------
async function waitAndOpen(attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    if (await portLive()) {
      if (NO_OPEN) log(`console ready at ${URL} (auto-open disabled)`);
      else open(URL);
      return;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  log(`server did not answer within ~15s; open ${URL} manually if it is still starting.`);
}

if (NO_OPEN) log('ACP_NO_OPEN=1 -> will not open a window');
await waitAndOpen();

// Web console (Phase 5.5): operate the Control Plane from a browser.
// Local only — binds 127.0.0.1. Zero deps; Node 22 --experimental-strip-types.
// Run: WORKSPACE_DIR=<node workspace with adapter packages> npm run web
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { appendFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { ControlPlane } from '../control/plane.ts';
import { getMerged, saveSettings, resetSettings, loadUserConfig, type AppSettings } from '../config/settings.ts';
import { describeCredential, setCredential, deleteCredential, storedNames } from '../config/secrets.ts';
import { probeAgent } from '../config/probe.ts';
import { authEvidence, nativeAuthEvidence } from '../config/auth-evidence.ts';
import { detectAgent } from '../config/detect.ts';
import { completeSetup, rerunSetup, setupView } from '../config/setup.ts';
import { configuredAgent, setupState } from '../config/settings.ts';
import { BUILTIN_RULES } from '../router/router.ts';
import { HISTORY_FILE } from '../config/paths.ts';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.ACP_WEB_PORT ?? 7777);
// HISTORY_FILE comes from config/paths.ts: it honours ACP_STATE_DIR, so a test run with an
// isolated state dir no longer appends to the real job history.
const EVENT_CAP = 400;
const HISTORY_LOAD = 60;

interface JobEvent { kind: string; text?: string; at: number }

interface Job {
  id: string;
  kind: 'ask' | 'parallel' | 'review';
  status: 'running' | 'done' | 'failed';
  request: any;
  result?: any;
  error?: string;
  events: JobEvent[];
  createdAt: number;
  finishedAt?: number;
}

const plane = new ControlPlane();
const jobs = new Map<string, Job>();

// Load recent finished jobs so history survives restarts (events are not persisted).
try {
  if (existsSync(HISTORY_FILE)) {
    const lines = readFileSync(HISTORY_FILE, 'utf8').trim().split('\n').filter(Boolean).slice(-HISTORY_LOAD);
    for (const line of lines) {
      try {
        const j = JSON.parse(line) as Job;
        j.events = j.events ?? [];
        jobs.set(j.id, j);
      } catch { /* skip corrupt line */ }
    }
  }
} catch { /* best-effort history */ }

function persistFinished(job: Job): void {
  try {
    appendFileSync(HISTORY_FILE, JSON.stringify({ ...job, events: undefined }) + '\n', 'utf8');
  } catch { /* best-effort */ }
}

function submit(kind: Job['kind'], request: any): Job {
  const id = randomUUID().slice(0, 8);
  const job: Job = { id, kind, status: 'running', request, events: [], createdAt: Date.now() };
  jobs.set(id, job);
  void runJob(job);
  return job;
}

async function runJob(job: Job): Promise<void> {
  const onEvent = (e: { kind: string; text?: string }) => {
    job.events.push({ ...e, at: Date.now() });
    if (job.events.length > EVENT_CAP) job.events.splice(0, job.events.length - EVENT_CAP);
  };
  try {
    if (job.kind === 'ask') {
      job.result = await plane.ask({ ...job.request, onEvent });
    } else if (job.kind === 'review') {
      // The full orchestration, not a single delegation: implement -> cross-vendor review ->
      // neutral verification -> optional arbitration. heteroReview reports its stage boundaries
      // through the same onEvent, so this job streams like the other two.
      job.result = await plane.heteroReview({ ...job.request, onEvent });
    } else {
      job.result = await plane.parallel(job.request.jobs, job.request.concurrency, onEvent);
    }
    job.status = 'done';
  } catch (e: any) {
    job.status = 'failed';
    job.error = String(e?.message ?? e).slice(0, 500);
  } finally {
    job.finishedAt = Date.now();
    persistFinished(job);
  }
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

// --- directory picker -------------------------------------------------------------------
// Why the server enumerates rather than the browser: no browser API returns an absolute path.
// `showDirectoryPicker()` yields a FileSystemDirectoryHandle and `<input webkitdirectory>`
// yields only `webkitRelativePath` — both deliberately withhold the real path from page JS.
// Since this server runs on the caller's own machine it can list directories itself and hand
// back absolute paths. Directories only: file names are never returned, so the endpoint says
// nothing about file contents. Same trust boundary as the rest of this console, which already
// spawns agents with the caller's privileges, and binds 127.0.0.1 only.
const DIR_CAP = 500;

interface DirListing {
  path: string;
  parent: string | null;
  entries: { name: string; path: string }[];
  roots: { name: string; path: string }[];
  truncated: boolean;
}

function driveRoots(): { name: string; path: string }[] {
  const out: { name: string; path: string }[] = [];
  if (process.platform === 'win32') {
    for (let c = 65; c <= 90; c++) {
      const p = `${String.fromCharCode(c)}:\\`;
      if (existsSync(p)) out.push({ name: p, path: p });
    }
  } else {
    out.push({ name: '/', path: '/' });
  }
  const home = homedir();
  if (home && !out.some((r) => r.path === home)) out.push({ name: `~ ${home}`, path: home });
  return out;
}

/** List the sub-directories of `raw`; empty `raw` falls back to the home directory. */
function listDirs(raw: string): DirListing | { error: string } {
  const roots = driveRoots();
  const target = raw.trim() || homedir() || roots[0]?.path || process.cwd();
  try {
    const dirs: { name: string; path: string }[] = [];
    for (const d of readdirSync(target, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;                 // directories only — never file names
      dirs.push({ name: d.name, path: join(target, d.name) });
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name));
    const parent = dirname(target);
    return {
      path: target,
      parent: parent === target ? null : parent,       // null at a filesystem root
      entries: dirs.slice(0, DIR_CAP),
      roots,
      truncated: dirs.length > DIR_CAP,
    };
  } catch (e: any) {
    return { error: `无法读取 ${target}：${String(e?.message ?? e).slice(0, 160)}` };
  }
}

// --- v3 settings helpers ---------------------------------------------------------------

// Issue #6: this used to be (a) a directory-level guess for claude — `~/.claude` is created by
// any adapter run, so it proved nothing — and (b) an either/or between the env/secrets seam and
// native login, which meant a machine WITH `~/.codex/auth.json` still showed "✕ 未配置" and a
// machine with neither showed nothing at all. Both facts are now reported side by side, each
// tri-state, and the combined verdict comes from the evidence module.
function agentRows() {
  const merged = getMerged();
  return Object.entries(merged.agents).map(([id, a]) => {
    const ev = authEvidence(id, a.credentialRef);
    const cred = a.credentialRef ? describeCredential(a.credentialRef) : null;
    const native = nativeAuthEvidence(id);
    const detection = detectAgent(a);
    return {
      id,
      enabled: a.enabled !== false,
      transport: a.transport ?? 'acp',
      command: a.command,
      args: a.args,
      profile: a.profile ?? null,
      credentialRef: a.credentialRef ?? null,
      credentialNative: a.credentialNative,
      credential: cred ? { configured: cred.configured, source: cred.source } : null,
      nativeAuth: { present: native.present, detail: native.detail },
      evidence: ev,
      // issue #7: three independent facts, all exposed so the UI never has to guess.
      detected: detection.detected,
      detection: detection.detail,
      confirmed: a.confirmed === true,
      configured: configuredAgent(id),
      // 'unconfirmed' is deliberately distinct from 'disabled' (user said no) and from
      // 'missing' (user said yes, but no credentials exist here).
      authState: a.enabled === false ? 'disabled'
        : !configuredAgent(id) ? 'unconfirmed'
        : ev.state === 'present' ? 'ok'
        : ev.state === 'absent' ? 'missing'
        : 'unknown',
      defaults: a.defaults ?? {},
      limits: a.limits ?? {},
      modelOverrides: a.modelOverrides ?? {},
    };
  });
}

function allCredentialNames(): string[] {
  const merged = getMerged();
  const names = new Set<string>(['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']);
  for (const a of Object.values(merged.agents)) if (a.credentialRef) names.add(a.credentialRef);
  for (const n of storedNames()) names.add(n);
  return [...names];
}

function noteRecentCwd(cwd: string): void {
  try {
    const merged = getMerged();
    const list = [cwd, ...(merged.workspace.recentCwds ?? [])].filter((x, i, arr) => x && arr.indexOf(x) === i).slice(0, 8);
    if (JSON.stringify(list) !== JSON.stringify(merged.workspace.recentCwds ?? [])) {
      saveSettings({ workspace: { recentCwds: list } });
    }
  } catch { /* best-effort */ }
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 1_000_000) { reject(new Error('body too large (1MB limit)')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(readFileSync(join(here, 'index.html')));
      return;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/fonts/')) {
      const name = url.pathname.slice('/fonts/'.length);
      if (!/^[\w.-]+\.(woff2|txt)$/.test(name)) { json(res, 400, { error: 'bad font path' }); return; }
      const p = join(here, 'fonts', name);
      if (!existsSync(p)) { json(res, 404, { error: 'no such font' }); return; }
      res.writeHead(200, {
        'content-type': name.endsWith('.woff2') ? 'font/woff2' : 'text/plain; charset=utf-8',
        'cache-control': 'max-age=86400',
      });
      res.end(readFileSync(p));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/fs/dirs') {
      const r = listDirs(url.searchParams.get('path') ?? '');
      if ('error' in r) { json(res, 400, r); return; }
      json(res, 200, r);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      json(res, 200, { agents: plane.status(), openSessions: plane.listSessions(), budget: plane.budgetStats() });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/jobs') {
      json(res, 200, [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/jobs/clear') {
      for (const [id, j] of jobs) if (j.status !== 'running') jobs.delete(id);
      try { writeFileSync(HISTORY_FILE, '', 'utf8'); } catch { /* best-effort */ }
      json(res, 200, { cleared: true });
      return;
    }

    // --- v3 settings & agents -----------------------------------------------------------
    if (req.method === 'GET' && url.pathname === '/api/settings') {
      const { config, error } = loadUserConfig();
      const merged = getMerged();
      const effectiveRouting: Record<string, { agent: string; effort?: string; source: 'default' | 'user' }> = {};
      for (const t of Object.keys(BUILTIN_RULES)) {
        const u = merged.routing.rules?.[t];
        effectiveRouting[t] = u?.agent
          ? { agent: u.agent, effort: u.effort, source: 'user' }
          : { agent: (BUILTIN_RULES as any)[t].agent, effort: (BUILTIN_RULES as any)[t].effort, source: 'default' };
      }
      json(res, 200, { merged, user: config, userError: error, effectiveRouting });
      return;
    }
    if (req.method === 'PUT' && url.pathname === '/api/settings') {
      const body = await readBody(req);
      try {
        const merged = saveSettings(body as Partial<AppSettings>);
        plane.applyBudget(merged.budget);
        json(res, 200, { merged });
      } catch (e: any) {
        // Validation failures are client errors (400), with the field-level reason.
        json(res, 400, { error: String(e?.message ?? e) });
      }
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/settings/reset') {
      const body = await readBody(req);
      const section = body.section;
      if (!['agents', 'routing', 'budget', 'workspace', 'teams'].includes(section)) {
        json(res, 400, { error: `unknown section: ${section}` });
        return;
      }
      const merged = resetSettings(section, body.sub);
      plane.applyBudget(merged.budget);
      json(res, 200, { merged });
      return;
    }
    // --- first-run wizard (issue #7) -----------------------------------------------------
    // Read-only view: what the machine COULD run (detected), who the user confirmed, and the
    // credential evidence for each. Deliberately separate from /api/agents: that endpoint
    // describes an agent's configuration, this one describes the setup decision.
    if (req.method === 'GET' && url.pathname === '/api/setup') {
      json(res, 200, setupView());
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/setup') {
      const body = await readBody(req);
      if (!body.agents || typeof body.agents !== 'object' || Array.isArray(body.agents)) {
        json(res, 400, { error: 'agents 必填（{ id: { confirm, command?, args?, credentialRef?, credentialValue? } }）' });
        return;
      }
      try {
        const merged = completeSetup(body.agents);
        plane.applyBudget(merged.budget);
        json(res, 200, { merged, setup: setupView() });
      } catch (e: any) {
        json(res, 400, { error: String(e?.message ?? e) });
      }
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/setup/rerun') {
      rerunSetup();
      json(res, 200, setupView());
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/agents') {
      json(res, 200, { agents: agentRows() });
      return;
    }
    const mProbe = url.pathname.match(/^\/api\/agents\/([\w-]+)\/test$/);
    if (req.method === 'POST' && mProbe) {
      const id = mProbe[1];
      const a = getMerged().agents[id];
      if (!a) { json(res, 404, { error: `unknown agent: ${id}` }); return; }
      if (a.enabled === false) { json(res, 400, { error: `agent ${id} 已禁用，先启用再探测` }); return; }
      const result = await probeAgent(id, { transport: a.transport, command: a.command, args: a.args });
      plane.registry.reload();
      json(res, 200, result);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/credentials') {
      // Status only — values never leave the server (dsh credential seam).
      json(res, 200, { credentials: allCredentialNames().map(describeCredential) });
      return;
    }
    const mCred = url.pathname.match(/^\/api\/credentials\/([A-Za-z_][A-Za-z0-9_]*)$/);
    if (mCred && (req.method === 'PUT' || req.method === 'DELETE')) {
      const name = mCred[1];
      if (req.method === 'DELETE') {
        deleteCredential(name);
        json(res, 200, describeCredential(name));
        return;
      }
      const body = await readBody(req);
      if (typeof body.value !== 'string') { json(res, 400, { error: 'value (string) is required' }); return; }
      setCredential(name, body.value);
      json(res, 200, describeCredential(name));
      return;
    }
    const m = url.pathname.match(/^\/api\/jobs\/([\w-]+)$/);
    if (req.method === 'GET' && m) {
      const j = jobs.get(m[1]);
      if (!j) { json(res, 404, { error: 'no such job' }); return; }
      json(res, 200, j);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/budget/reset') {
      plane.budget.resetDay();
      json(res, 200, plane.budget.stats());
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/integrations') {
      const ws = process.env.WORKSPACE_DIR ?? '<WORKSPACE_DIR>';
      const mcpSnippet = JSON.stringify({
        mcpServers: {
          'agent-control-plane': {
            command: 'node',
            args: ['--experimental-strip-types', join(here, '..', 'mcp', 'server.ts')],
            env: { WORKSPACE_DIR: ws },
          },
        },
      }, null, 2);
      json(res, 200, { mcpSnippet, webPort: PORT, bind: '127.0.0.1' });
      return;
    }
    if (req.method === 'POST' && (url.pathname === '/api/ask' || url.pathname === '/api/parallel' || url.pathname === '/api/review')) {
      const body = await readBody(req);
      if (url.pathname === '/api/ask') {
        if (!body.task || !body.cwd) { json(res, 400, { error: 'task and cwd are required' }); return; }
        noteRecentCwd(String(body.cwd));
        json(res, 200, submit('ask', body));
        return;
      }
      if (url.pathname === '/api/review') {
        if (!body.task || !body.cwd) { json(res, 400, { error: 'task and cwd are required' }); return; }
        noteRecentCwd(String(body.cwd));
        json(res, 200, submit('review', body));
        return;
      }
      if (!Array.isArray(body.jobs) || body.jobs.length === 0) {
        json(res, 400, { error: 'jobs must be a non-empty array' });
        return;
      }
      const cwds = [...new Set(body.jobs.map((x: any) => String(x.cwd ?? '')))].filter(Boolean) as string[];
      if (cwds.length === 1) noteRecentCwd(cwds[0]);
      json(res, 200, submit('parallel', body));
      return;
    }
    json(res, 404, { error: 'not found' });
  } catch (e: any) {
    json(res, 500, { error: String(e?.message ?? e).slice(0, 300) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`ACP web console: http://127.0.0.1:${PORT} (local only; jobs in memory)`);
});

async function shutdown(): Promise<void> {
  try { await plane.shutdown(); } catch { /* noop */ }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

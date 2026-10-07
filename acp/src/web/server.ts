// Web console (Phase 5.5): operate the Control Plane from a browser.
// Local only — binds 127.0.0.1. Zero deps; Node 22 --experimental-strip-types.
// Run: WORKSPACE_DIR=<node workspace with adapter packages> npm run web
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { ControlPlane } from '../control/plane.ts';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.ACP_WEB_PORT ?? 7777);
const HISTORY_FILE = join(here, '..', '..', 'state', 'web-jobs.jsonl');
const EVENT_CAP = 400;
const HISTORY_LOAD = 60;

interface JobEvent { kind: string; text?: string; at: number }

interface Job {
  id: string;
  kind: 'ask' | 'parallel';
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
    job.result = job.kind === 'ask'
      ? await plane.ask({ ...job.request, onEvent })
      : await plane.parallel(job.request.jobs, job.request.concurrency, onEvent);
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
    const m = url.pathname.match(/^\/api\/jobs\/([\w-]+)$/);
    if (req.method === 'GET' && m) {
      const j = jobs.get(m[1]);
      if (!j) { json(res, 404, { error: 'no such job' }); return; }
      json(res, 200, j);
      return;
    }
    if (req.method === 'POST' && (url.pathname === '/api/ask' || url.pathname === '/api/parallel')) {
      const body = await readBody(req);
      if (url.pathname === '/api/ask') {
        if (!body.task || !body.cwd) { json(res, 400, { error: 'task and cwd are required' }); return; }
        json(res, 200, submit('ask', body));
        return;
      }
      if (!Array.isArray(body.jobs) || body.jobs.length === 0) {
        json(res, 400, { error: 'jobs must be a non-empty array' });
        return;
      }
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

// Phase 5: native fan-out/fan-in batch orchestration ("whole-tree batch").
// Rationale: fractal 1.3.0 is not viable on native Windows (fcntl.flock at its core,
// tmux in core/loop.py) and CAO requires tmux/WSL2 — so the batch primitive lives HERE,
// on top of the four verified drivers, instead of delegating to an unrunnable tool.
// Each job is a full ask(): independent routing, fallback, budget, verdict, workspace.
import type { AgentId, AgentResult, TokenUsage } from '../core/types.ts';
import type { TaskHints } from '../router/router.ts';
import type { ControlPlane } from '../control/plane.ts';

export interface ParallelJob {
  id?: string;
  task: string;
  cwd: string;
  agent?: AgentId;
  model?: string;
  effort?: string;
  taskType?: TaskHints['taskType'];
  differentVendorFrom?: string[];
  verdict?: boolean;
  maxToolCalls?: number;
  workspaceMode?: 'shared' | 'worktree';
  timeoutMs?: number;
}

export interface ParallelJobOutcome {
  id: string;
  agent?: AgentId;
  ok: boolean;
  error?: string;
  result?: AgentResult;
}

export interface ParallelOutcome {
  results: ParallelJobOutcome[];
  summary: {
    total: number;
    ok: number;
    failed: number;
    durationMs: number;
    usage: TokenUsage;          // sum over jobs that reported usage
    wallVsSerialMsSaved: number; // >0 means concurrency actually helped
  };
}

const DEFAULT_CONCURRENCY = 3;

export async function runParallel(plane: ControlPlane, jobs: ParallelJob[], concurrency?: number): Promise<ParallelOutcome> {
  if (!Array.isArray(jobs) || jobs.length === 0) throw new Error('parallel: jobs must be a non-empty array');
  const limit = Math.max(1, Math.min(concurrency ?? DEFAULT_CONCURRENCY, jobs.length));
  const t0 = Date.now();

  const outcomes: ParallelJobOutcome[] = new Array(jobs.length);
  let cursor = 0;
  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= jobs.length) return;
      const job = jobs[i];
      const id = job.id ?? `job-${i}`;
      try {
        const r = await plane.ask({
          task: job.task,
          cwd: job.cwd,
          agent: job.agent,
          model: job.model,
          effort: job.effort,
          taskType: job.taskType,
          differentVendorFrom: job.differentVendorFrom,
          verdict: job.verdict,
          maxToolCalls: job.maxToolCalls,
          workspaceMode: job.workspaceMode,
          timeoutMs: job.timeoutMs,
        });
        outcomes[i] = { id, agent: r.agent, ok: r.ok, error: r.error, result: r };
      } catch (e: any) {
        // Budget caps and routing errors reject the job, never the batch.
        outcomes[i] = { id, ok: false, error: String(e?.message ?? e).slice(0, 300) };
      }
    }
  };

  // Sum of individual durations approximates the serial baseline for the same jobs.
  await Promise.all(Array.from({ length: limit }, () => worker()));
  const wallMs = Date.now() - t0;
  const serialMs = outcomes.reduce((acc, o) => acc + (o.result?.durationMs ?? 0), 0);

  const usage: TokenUsage = {};
  const acc = (k: keyof TokenUsage, v?: number) => { if (v) (usage as any)[k] = ((usage as any)[k] ?? 0) + v; };
  for (const o of outcomes) {
    acc('input', o.result?.usage?.input);
    acc('output', o.result?.usage?.output);
    acc('cachedRead', o.result?.usage?.cachedRead);
    acc('thinking', o.result?.usage?.thinking);
  }

  return {
    results: outcomes,
    summary: {
      total: jobs.length,
      ok: outcomes.filter((o) => o.ok).length,
      failed: outcomes.filter((o) => !o.ok).length,
      durationMs: wallMs,
      usage,
      wallVsSerialMsSaved: Math.max(0, serialMs - wallMs),
    },
  };
}

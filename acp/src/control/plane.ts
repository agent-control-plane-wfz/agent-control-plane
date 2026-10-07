// ControlPlane — composes Registry + Router + Drivers + Workspace + Budget + Verdict.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentId, AgentResult, TokenUsage, ConfigApplyRecord } from '../core/types.ts';
import { verdictInstruction, extractVerdict, VERDICT_RETRY_PROMPT, type Verdict } from '../core/verdict.ts';
import { AcpDriver, type AcpSession } from '../drivers/acp-driver.ts';
import { DshDriver } from '../drivers/dsh-driver.ts';
import { Registry } from '../registry/registry.ts';
import { route, type TaskHints } from '../router/router.ts';
import { classifyTask, llmRouterEnabled } from '../router/llm-router.ts';
import { prepareWorkspace, type PreparedWorkspace } from '../workspace/manager.ts';
import { heteroReview as runHeteroReview, type HeteroReviewOptions, type HeteroReviewOutcome } from '../review/review.ts';
import { Budget } from '../budget/budget.ts';
import { runParallel, type ParallelJob, type ParallelOutcome } from '../batch/parallel.ts';

const here = dirname(fileURLToPath(import.meta.url));

interface AcpAgentConfig { command: string; args: string[] }

function loadAcpConfigs(): Record<string, AcpAgentConfig> {
  const matrixPath = join(here, '..', '..', '..', 'registry', 'capability-matrix.json');
  const matrix = JSON.parse(readFileSync(matrixPath, 'utf8'));
  // A1 (audit): no silent fallback to a personal path — fail loudly with instructions.
  const wsDir = process.env.WORKSPACE_DIR;
  if (!wsDir) {
    throw new Error(
      'WORKSPACE_DIR is not set. Point it to the directory containing the harness packages '
      + '(@agentclientprotocol/claude-agent-acp, @agentclientprotocol/codex-acp, @deepseek-ai/dsh under node_modules/). '
      + 'Example: WORKSPACE_DIR=C:\\Users\\me\\.workbuddy\\binaries\\node\\workspace',
    );
  }
  const ws = join(wsDir, 'node_modules');
  const node = process.execPath;
  const out: Record<string, AcpAgentConfig> = {};
  const oc = matrix.agents.opencode?.command as string | undefined;
  if (oc) out.opencode = { command: oc.split(' acp')[0], args: ['acp'] };
  out.claude = { command: node, args: [join(ws, '@agentclientprotocol', 'claude-agent-acp', 'dist', 'index.js')] };
  out.codex = { command: node, args: [join(ws, '@agentclientprotocol', 'codex-acp', 'dist', 'index.js')] };
  return out;
}

// D2: transport/auth-class failures are eligible for fallback; content failures are not.
function isTransportError(err?: string): boolean {
  if (!err) return false;
  return /timeout|exited|MODULE_NOT_FOUND|ENOENT|ECONN|ENOTFOUND|EACCES|spawn|not found|auth|unauthor|credential|login/i.test(err);
}

export interface AskOptions {
  task: string;
  cwd: string;
  agent?: AgentId;
  model?: string;
  effort?: string;
  mode?: string;
  taskType?: TaskHints['taskType'];
  differentVendorFrom?: string[];
  timeoutMs?: number;
  keepSession?: boolean;
  workspaceMode?: 'shared' | 'worktree';   // default 'shared'; worktree needs repoDir to be a git repo
  verdict?: boolean;                        // structured verdict contract (instruction + extraction, 1 retry)
  maxToolCalls?: number;                    // per-call hard gate
  fallback?: boolean;                       // default true: retry on transport-class failure via fallbackChain
}

export class ControlPlane {
  readonly registry: Registry;
  readonly budget: Budget;
  private acpConfigs = loadAcpConfigs();
  private drivers = new Map<AgentId, AcpDriver>();
  private sessions = new Map<string, AcpSession>(); // key: `${agent}:${sessionId}`
  private dshSessions = new Map<string, string>();  // dsh sessionId -> cwd (one-shot process; resume via --session-id)
  private worktrees = new Set<PreparedWorkspace>(); // C8: tracked so shutdown() can clean up what callers did not

  constructor(registry?: Registry, budget?: Budget) {
    this.registry = registry ?? new Registry();
    this.budget = budget ?? new Budget({
      dailyRequests: Number(process.env.ACP_DAILY_REQUESTS ?? 0) || undefined,
      dailyTokens: Number(process.env.ACP_DAILY_TOKENS ?? 0) || undefined,
    });
  }

  route(hints: TaskHints) {
    return route(this.registry, hints);
  }

  status() {
    return this.registry.statusList();
  }

  async ask(opts: AskOptions): Promise<AgentResult> {
    const t0 = Date.now();
    this.budget.checkRequest();

    // LLM routing for ambiguous tasks: no explicit agent AND no matching rule hint.
    let taskType = opts.taskType;
    let llmReason: string | undefined;
    if (!taskType && !opts.agent && !opts.model && llmRouterEnabled()) {
      const cls = await classifyTask(this, opts.task, opts.cwd);
      if (cls) { taskType = cls.taskType; llmReason = `llm:${cls.reason}`; }
    }
    const decision = this.route({
      agent: opts.agent,
      model: opts.model,
      effort: opts.effort,
      mode: opts.mode,
      taskType,
      requirements: { differentVendorFrom: opts.differentVendorFrom },
    });
    if (llmReason) decision.reason = `${decision.reason} [${llmReason}]`;

    // Workspace (Phase 3): shared cwd or isolated per-agent git worktree.
    // B5/C8 (audit): worktree failures are NOT silent — either error out (explicit request) or record why.
    let ws: PreparedWorkspace | undefined;
    let effCwd = opts.cwd;
    let workspaceNote: string | undefined;
    if (opts.workspaceMode === 'worktree') {
      try {
        ws = await prepareWorkspace({ repoDir: opts.cwd, agent: decision.agent, mode: 'worktree' });
        effCwd = ws.path;
        this.worktrees.add(ws);
      } catch (e: any) {
        workspaceNote = `worktree preparation failed, fell back to shared cwd: ${String(e?.message ?? e).slice(0, 200)}`;
      }
    }

    const finalTask = opts.verdict ? opts.task + verdictInstruction() : opts.task;

    // D2: fallback chain — retry transport-class failures on the next candidate.
    const useFallback = opts.fallback ?? true;
    const chain: AgentId[] = [decision.agent];
    if (useFallback) for (const a of decision.fallbackChain) if (a !== decision.agent && !chain.includes(a)) chain.push(a);

    let r: AgentResult | undefined;
    const attempts: string[] = [];
    for (const agent of chain) {
      r = agent === 'dsh'
        ? await this.runDsh(finalTask, { cwd: effCwd, timeoutMs: opts.timeoutMs }, t0, decision)
        : await this.runAcp(agent, decision, finalTask, { cwd: effCwd, opts, keep: !!opts.keepSession, verdict: !!opts.verdict }, t0);
      if (r.ok) break;
      if (!isTransportError(r.error)) break;
      attempts.push(`${agent}: ${(r.error ?? '').slice(0, 160)}`);
      r = undefined;
    }
    if (!r) {
      // every candidate failed at transport level
      r = {
        agent: decision.agent, ok: false, text: '',
        error: `all fallback candidates failed — ${attempts.join(' | ')}`,
        toolCalls: 0, durationMs: Date.now() - t0,
      };
    }
    if (attempts.length) r.error = [r.error, `fallback trail: ${attempts.join(' | ')}`].filter(Boolean).join(' || ');

    r.workspace = ws
      ? { kind: ws.kind, path: ws.path, branch: ws.branch }
      : { kind: 'shared', path: opts.cwd };
    if (workspaceNote) r.workspaceNote = workspaceNote;
    this.budget.record(r.usage);
    return r;
  }

  review(opts: { task: string; cwd: string; excludeVendors: string[]; effort?: string; timeoutMs?: number; verdict?: boolean }) {
    return this.ask({ ...opts, taskType: 'review', differentVendorFrom: opts.excludeVendors, verdict: opts.verdict ?? true });
  }

  // Phase 4: full implementation -> cross-vendor review -> neutral verification -> arbitration.
  heteroReview(opts: HeteroReviewOptions): Promise<HeteroReviewOutcome> {
    return runHeteroReview(this, opts);
  }

  // Phase 5: native fan-out/fan-in batch (fractal/CAO replacement on Windows — see batch/parallel.ts).
  parallel(jobs: ParallelJob[], concurrency?: number): Promise<ParallelOutcome> {
    return runParallel(this, jobs, concurrency);
  }

  async send(agent: AgentId, sessionId: string, task: string, timeoutMs?: number): Promise<AgentResult> {
    const t0 = Date.now();
    this.budget.checkRequest();
    // dsh is a one-shot process — resume via --session-id instead of a live ACP session.
    if (agent === 'dsh') {
      const cwd = this.dshSessions.get(sessionId);
      if (!cwd) {
        return {
          agent, sessionId, ok: false, text: '',
          error: `dsh session not found: ${sessionId}. It must come from a successful dsh ask in this process.`,
          toolCalls: 0, durationMs: Date.now() - t0,
        };
      }
      const r = await DshDriver.run(task, { cwd, sessionId, timeoutMs: timeoutMs ?? 300_000 });
      const out: AgentResult = {
        agent, sessionId,
        ok: r.exitCode === 0, text: r.text || `(dsh exit=${r.exitCode}) ${r.stderr.slice(-500)}`,
        stopReason: r.exitCode === 0 ? 'end_turn' : 'error',
        toolCalls: 0, durationMs: Date.now() - t0, usage: r.usage,
      };
      this.budget.record(out.usage);
      return out;
    }
    const s = this.sessions.get(`${agent}:${sessionId}`);
    if (!s) {
      return {
        agent, sessionId, ok: false, text: '',
        error: `session not found: ${agent}:${sessionId}. Spawn with spawn_agent(keepSession) first.`,
        toolCalls: 0, durationMs: Date.now() - t0,
      };
    }
    const driver = this.acpDriver(agent);
    const outcome = await driver.run(s, task, { timeoutMs: timeoutMs ?? 300_000 });
    const r: AgentResult = {
      agent, sessionId,
      // C3 (audit): only an explicit end_turn counts as success — no optimistic undefined.
      ok: outcome.stopReason === 'end_turn',
      text: outcome.text, stopReason: outcome.stopReason,
      toolCalls: outcome.toolCalls, durationMs: Date.now() - t0,
      usage: outcome.usage,
    };
    this.budget.record(r.usage);
    return r;
  }

  async stop(agent: AgentId, sessionId: string): Promise<{ stopped: boolean }> {
    const s = this.sessions.get(`${agent}:${sessionId}`);
    if (!s) return { stopped: false };
    const d = this.acpDriver(agent);
    await d.cancel(s);
    return { stopped: true };
  }

  listSessions(): string[] {
    return [...this.sessions.keys()];
  }

  budgetStats() {
    return this.budget.stats();
  }

  // Close every live session (kills child agent processes) and clean up worktrees
  // that callers have not cleaned themselves. Call before process exit — ACP children
  // keep the Node event loop alive otherwise.
  async shutdown(): Promise<void> {
    for (const [, s] of this.sessions) {
      try { await s.rpc.close(); } catch { /* noop */ }
    }
    this.sessions.clear();
    for (const ws of this.worktrees) {
      try { await ws.cleanup(); } catch { /* noop */ }
    }
    this.worktrees.clear();
  }

  // C4 (audit): report only what actually took effect — no asserted-but-unapplied model/effort.
  private static effective(applied: ConfigApplyRecord[] | undefined, kind: string): string | undefined {
    const rec = applied?.find((a) => a.id === kind || (kind === 'effort' && a.id === 'reasoning_effort'));
    return rec?.ok ? rec.value : undefined;
  }

  private acpDriver(agent: AgentId): AcpDriver {
    let d = this.drivers.get(agent);
    if (!d) {
      const cfg = this.acpConfigs[agent];
      if (!cfg) throw new Error(`no ACP config for agent ${agent}`);
      d = AcpDriver.from({ agent, ...cfg });
      this.drivers.set(agent, d);
    }
    return d;
  }

  private async runDsh(task: string, o: { cwd: string; timeoutMs?: number }, t0: number,
    decision: { effort?: string; model?: string }): Promise<AgentResult> {
    const r = await DshDriver.run(task, { cwd: o.cwd, timeoutMs: o.timeoutMs });
    if (r.sessionId && r.exitCode === 0) this.dshSessions.set(r.sessionId, o.cwd);
    return {
      agent: 'dsh',
      // C4 (audit): dsh headless exposes no external model/effort flag — do not echo the route decision.
      model: undefined, effort: undefined,
      sessionId: r.sessionId,
      ok: r.exitCode === 0, text: r.text || `(dsh exit=${r.exitCode}) ${r.stderr.slice(-500)}`,
      stopReason: r.exitCode === 0 ? 'end_turn' : 'error', toolCalls: 0,
      durationMs: Date.now() - t0,
      usage: r.usage,
      applied: [{ id: 'model', value: decision.model, ok: false, via: 'not-supported', error: 'dsh headless has no external model/effort flag; uses its own default' }],
    };
  }

  private async runAcp(agent: AgentId, decision: { model?: string; effort?: string; mode?: string }, task: string,
    o: { cwd: string; opts: AskOptions; keep: boolean; verdict: boolean }, t0: number): Promise<AgentResult> {
    const driver = this.acpDriver(agent);
    let session: AcpSession | undefined;
    const applied: ConfigApplyRecord[] = [];
    try {
      let rpc;
      try {
        rpc = await driver.connect(o.cwd);
      } catch (e: any) {
        // C7 (audit): connect() failure must not leak the spawned child process.
        throw e;
      }
      try {
        session = await driver.newSession(rpc, o.cwd);
        this.sessions.set(`${agent}:${session.sessionId}`, session);

        const resolveOptionId = (kind: 'model' | 'effort' | 'mode'): string | undefined => {
          if (session!.configOptions.some((c) => c.id === kind)) return kind;
          if (kind === 'effort') {
            const byCategory = session!.configOptions.find((c) => c.category === 'thought_level');
            if (byCategory) return byCategory.id;
          }
          return undefined;
        };
        const apply: Array<[string, string | undefined]> = [
          ['model', o.opts.model ?? decision.model],
          ['effort', o.opts.effort ?? decision.effort],
          ['mode', o.opts.mode ?? decision.mode],
        ];
        for (const [kind, value] of apply) {
          if (!value) continue;
          const id = resolveOptionId(kind as any);
          if (!id) { applied.push({ id: kind, value, ok: false, via: 'option-not-offered', error: 'agent did not advertise this config option' }); continue; }
          const cur = session.configOptions.find((c) => c.id === id)?.currentValue;
          if (cur === value) { applied.push({ id, value, ok: true, via: 'already-set' }); continue; }
          applied.push({ id, value, ...(await driver.setConfig(session, id, value)) });
        }

        const outcome = await driver.run(session, task, { timeoutMs: o.opts.timeoutMs ?? 300_000, maxToolCalls: o.opts.maxToolCalls });
        let text = outcome.text;
        let verdict: Verdict | undefined;
        let verdictError: string | undefined;

        // B2 (audit): verdict retry must happen HERE, while the session is still alive.
        if (o.verdict) {
          let ex = extractVerdict(text);
          if (!ex.ok) {
            try {
              const retry = await driver.run(session, VERDICT_RETRY_PROMPT(ex.error), { timeoutMs: Math.min(o.opts.timeoutMs ?? 300_000, 120_000) });
              const ex2 = extractVerdict(retry.text);
              if (ex2.ok) { text = retry.text; ex = ex2; }
              else if (ex2.raw) text = retry.text; // show the retry content at least
            } catch { /* retry is best-effort */ }
          }
          if (ex.ok) verdict = ex.verdict;
          else verdictError = ex.error;
        }

        return {
          agent,
          // C4 (audit): echo only config that verifiably took effect.
          model: ControlPlane.effective(applied, 'model'),
          effort: ControlPlane.effective(applied, 'effort'),
          sessionId: session.sessionId,
          // C3 (audit): only explicit end_turn counts as success.
          ok: outcome.stopReason === 'end_turn',
          text, stopReason: outcome.stopReason,
          toolCalls: outcome.toolCalls, durationMs: Date.now() - t0,
          usage: outcome.usage, applied, verdict, verdictError,
        };
      } finally {
        if (session) {
          this.sessions.delete(`${agent}:${session.sessionId}`);
          await rpc.close();
        } else {
          // session/new failed after initialize — close rpc to avoid leaking the child (C7).
          await rpc.close();
        }
      }
    } catch (e: any) {
      return {
        agent, model: ControlPlane.effective(applied, 'model'), effort: ControlPlane.effective(applied, 'effort'),
        sessionId: session?.sessionId, ok: false,
        text: '', error: String(e?.message ?? e), toolCalls: 0, durationMs: Date.now() - t0,
        applied,
      };
    }
  }
}

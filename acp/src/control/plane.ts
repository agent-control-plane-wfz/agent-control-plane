// ControlPlane — composes Registry + Router + Drivers + Workspace + Budget + Verdict.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentId, AgentResult, TokenUsage, ConfigApplyRecord } from '../core/types.ts';
import { verdictInstruction, extractVerdict, type Verdict } from '../core/verdict.ts';
import { AcpDriver, type AcpSession } from '../drivers/acp-driver.ts';
import { DshDriver } from '../drivers/dsh-driver.ts';
import { Registry } from '../registry/registry.ts';
import { route, type TaskHints } from '../router/router.ts';
import { classifyTask, llmRouterEnabled } from '../router/llm-router.ts';
import { prepareWorkspace, type PreparedWorkspace } from '../workspace/manager.ts';
import { heteroReview as runHeteroReview, type HeteroReviewOptions, type HeteroReviewOutcome } from '../review/review.ts';
import { Budget } from '../budget/budget.ts';

const here = dirname(fileURLToPath(import.meta.url));

interface AcpAgentConfig { command: string; args: string[] }

function loadAcpConfigs(): Record<string, AcpAgentConfig> {
  const matrixPath = join(here, '..', '..', '..', 'registry', 'capability-matrix.json');
  const matrix = JSON.parse(readFileSync(matrixPath, 'utf8'));
  const ws = join(process.env.WORKSPACE_DIR
    ?? 'C:\\Users\\wfz\\.workbuddy\\binaries\\node\\workspace', 'node_modules');
  const node = process.execPath;
  const out: Record<string, AcpAgentConfig> = {};
  const oc = matrix.agents.opencode?.command as string | undefined;
  if (oc) out.opencode = { command: oc.split(' acp')[0], args: ['acp'] };
  out.claude = { command: node, args: [join(ws, '@agentclientprotocol', 'claude-agent-acp', 'dist', 'index.js')] };
  out.codex = { command: node, args: [join(ws, '@agentclientprotocol', 'codex-acp', 'dist', 'index.js')] };
  return out;
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
  // Phase 3:
  workspaceMode?: 'shared' | 'worktree';   // default 'shared'; worktree needs repoDir to be a git repo
  verdict?: boolean;                        // structured verdict contract (instruction + extraction, 1 retry)
  maxToolCalls?: number;                    // per-call hard gate
}

export class ControlPlane {
  readonly registry: Registry;
  readonly budget: Budget;
  private acpConfigs = loadAcpConfigs();
  private drivers = new Map<AgentId, AcpDriver>();
  private sessions = new Map<string, AcpSession>(); // key: `${agent}:${sessionId}`
  private dshSessions = new Map<string, string>();  // dsh sessionId -> cwd (one-shot process; resume via --session-id)

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
    let ws: PreparedWorkspace | undefined;
    let effCwd = opts.cwd;
    if (opts.workspaceMode === 'worktree') {
      try {
        ws = await prepareWorkspace({ repoDir: opts.cwd, agent: decision.agent, mode: 'worktree' });
        effCwd = ws.path;
      } catch { /* fall back to shared on failure */ }
    }

    const finalTask = opts.verdict ? opts.task + verdictInstruction() : opts.task;

    try {
      const r = decision.agent === 'dsh'
        ? await this.runDsh(decision.agent, decision.model, decision.effort, finalTask, { cwd: effCwd, timeoutMs: opts.timeoutMs, sessionId: undefined }, t0)
        : await this.runAcp(decision.agent, decision, finalTask, { cwd: effCwd, opts, keep: !!opts.keepSession }, t0);
      r.workspace = ws ? { kind: ws.kind, path: ws.path, branch: ws.branch } : { kind: 'shared', path: opts.cwd };
      this.budget.record(r.usage);
      // Verdict contract (Phase 3): instruction already appended; extract, retry once on failure.
      if (opts.verdict && r.ok && r.text) {
        let ex = extractVerdict(r.text);
        if (!ex.ok) {
          const retry = decision.agent === 'dsh'
            ? null
            : await this.retryVerdict(decision.agent, r.sessionId, ex.error);
          if (retry) ex = extractVerdict(retry.text), r.text = retry.text;
        }
        if (ex.ok) r.verdict = ex.verdict;
        else r.verdictError = ex.error;
      }
      return r;
    } finally {
      if (ws && !opts.keepSession) await ws.cleanup();
    }
  }

  review(opts: { task: string; cwd: string; excludeVendors: string[]; effort?: string; timeoutMs?: number; verdict?: boolean }) {
    return this.ask({ ...opts, taskType: 'review', differentVendorFrom: opts.excludeVendors, verdict: opts.verdict ?? true });
  }

  // Phase 4: full implementation -> cross-vendor review -> neutral verification -> arbitration.
  heteroReview(opts: HeteroReviewOptions): Promise<HeteroReviewOutcome> {
    return runHeteroReview(this, opts);
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
      ok: outcome.stopReason === 'end_turn' || outcome.stopReason === undefined,
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

  // Close every live session (kills child agent processes). Call before process exit —
  // ACP children keep the Node event loop alive otherwise.
  async shutdown(): Promise<void> {
    for (const [, s] of this.sessions) {
      try { await s.rpc.close(); } catch { /* noop */ }
    }
    this.sessions.clear();
  }

  private async runDsh(agent: 'dsh', model?: string, effort?: string, task?: string, o: { cwd: string; timeoutMs?: number; sessionId?: string }, t0: number): Promise<AgentResult> {
    const r = await DshDriver.run(task!, { cwd: o.cwd, timeoutMs: o.timeoutMs, sessionId: o.sessionId });
    if (r.sessionId && r.exitCode === 0) this.dshSessions.set(r.sessionId, o.cwd);
    return {
      agent, model, effort, sessionId: r.sessionId,
      ok: r.exitCode === 0, text: r.text || `(dsh exit=${r.exitCode}) ${r.stderr.slice(-500)}`,
      stopReason: r.exitCode === 0 ? 'end_turn' : 'error', toolCalls: 0,
      durationMs: Date.now() - t0,
      usage: r.usage,
    };
  }

  private async runAcp(agent: AgentId, decision: { model?: string; effort?: string; mode?: string }, task: string,
    o: { cwd: string; opts: AskOptions; keep: boolean }, t0: number): Promise<AgentResult> {
    const driver = this.acpDriver(agent);
    let session: AcpSession | undefined;
    const applied: ConfigApplyRecord[] = [];
    try {
      const rpc = await driver.connect(o.cwd);
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
      return {
        agent, model: decision.model, effort: decision.effort,
        sessionId: session.sessionId,
        ok: outcome.stopReason === 'end_turn' || outcome.stopReason === undefined,
        text: outcome.text, stopReason: outcome.stopReason,
        toolCalls: outcome.toolCalls, durationMs: Date.now() - t0,
        usage: outcome.usage, applied,
      };
    } catch (e: any) {
      return {
        agent, model: decision.model, effort: decision.effort,
        sessionId: session?.sessionId, ok: false,
        text: '', error: String(e?.message ?? e), toolCalls: 0, durationMs: Date.now() - t0,
        applied,
      };
    } finally {
      if (session && !o.keep) {
        this.sessions.delete(`${agent}:${session.sessionId}`);
        await session.rpc.close();
      }
    }
  }

  private async retryVerdict(agent: AgentId, sessionId: string | undefined, prevError: string): Promise<{ text: string } | null> {
    if (!sessionId) return null;
    try {
      const r = await this.send(agent, sessionId, `Your previous reply did not satisfy the required JSON output (${prevError}). Reply again with ONLY the JSON object.`);
      return r.ok ? { text: r.text } : null;
    } catch { return null; }
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
}

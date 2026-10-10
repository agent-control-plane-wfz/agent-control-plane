// ControlPlane — composes Registry + Router + Drivers + Workspace + Budget + Verdict + Settings.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentId, AgentResult, TokenUsage, ConfigApplyRecord } from '../core/types.ts';
import { verdictInstruction, extractVerdict, VERDICT_RETRY_PROMPT, type Verdict } from '../core/verdict.ts';
import { isTransportError } from '../core/transport-error.ts';
import { AcpDriver, type AcpSession } from '../drivers/acp-driver.ts';
import { DshDriver, DEFAULT_DSH_PROFILE } from '../drivers/dsh-driver.ts';
import { Registry } from '../registry/registry.ts';
import { route, type TaskHints } from '../router/router.ts';
import { classifyTask } from '../router/llm-router.ts';
import { prepareWorkspace, type PreparedWorkspace } from '../workspace/manager.ts';
import { heteroReview as runHeteroReview, type HeteroReviewOptions, type HeteroReviewOutcome } from '../review/review.ts';
import { Budget } from '../budget/budget.ts';
import { runParallel, type ParallelJob, type ParallelOutcome } from '../batch/parallel.ts';
import { getMerged, configuredAgent, type AgentSettings } from '../config/settings.ts';
import { getCredential } from '../config/secrets.ts';
import { authEvidence } from '../config/auth-evidence.ts';
import { applyPreset } from '../config/presets.ts';

const here = dirname(fileURLToPath(import.meta.url));

interface AcpAgentConfig { command: string; args: string[]; credentialRef?: string | null }

// v3: agent command/args/credential come from merged settings (user > env > matrix > defaults).
// Re-read per call — a small file, and gives live-apply right after Settings saves.
function agentSettingsOf(id: string): AgentSettings | undefined {
  return getMerged().agents[id];
}

function resolveAgentConfig(id: string): AcpAgentConfig {
  const a = agentSettingsOf(id);
  if (!a?.command || !a.args) throw new Error(`agent ${id} 未配置命令（设置 → Agents 里探测或填写）`);
  return { command: a.command, args: a.args, credentialRef: a.credentialRef ?? null };
}

/** Resolved dsh run form (issue #9). Precedence lives in settings.ts: user config > DSH_PROFILE > default. */
function dshProfileOf(): string {
  return agentSettingsOf('dsh')?.profile ?? DEFAULT_DSH_PROFILE;
}

// D2: transport/auth-class failures are eligible for fallback; content failures are not.
// (F8, issue #2: the matcher moved to core/transport-error.ts so it is unit-testable and
// no longer treats "author" as an auth failure — imported at the top of this file.)

export interface AskOptions {
  task: string;
  cwd: string;
  agent?: AgentId;
  model?: string;
  effort?: string;
  mode?: string;
  taskType?: TaskHints['taskType'];
  /** issue #11: named preset (see config/presets.ts). Fields set here win over the preset. */
  preset?: string;
  /** issue #11: prefer a model of this tier; the Router resolves it against this machine's table. */
  tier?: string;
  differentVendorFrom?: string[];
  timeoutMs?: number;
  keepSession?: boolean;
  workspaceMode?: 'shared' | 'worktree';   // default 'shared'; worktree needs repoDir to be a git repo
  verdict?: boolean;                        // structured verdict contract (instruction + extraction, 1 retry)
  maxToolCalls?: number;                    // per-call hard gate
  fallback?: boolean;                       // default true: retry on transport-class failure via fallbackChain
  onEvent?: (e: { kind: 'text' | 'tool' | 'tool_result' | 'thinking' | 'status'; text?: string; status?: string }) => void;  // live progress for UIs
}

export class ControlPlane {
  readonly registry: Registry;
  readonly budget: Budget;
  private drivers = new Map<AgentId, AcpDriver>();
  private sessions = new Map<string, AcpSession>(); // key: `${agent}:${sessionId}`
  private dshSessions = new Map<string, string>();  // dsh sessionId -> cwd (one-shot process; resume via --session-id)
  private worktrees = new Set<PreparedWorkspace>(); // C8: tracked so shutdown() can clean up what callers did not

  constructor(registry?: Registry, budget?: Budget) {
    this.registry = registry ?? new Registry();
    this.budget = budget ?? new Budget(getMerged().budget);
    // Issue #6: routing viability must reflect credential evidence on THIS machine — not a
    // declared snapshot, and never a probe's "process started". Resolved lazily per call so a
    // credential saved in the Settings UI takes effect without a restart.
    this.registry.setAuthEvidence((id) => authEvidence(id, agentSettingsOf(id)?.credentialRef).state);
  }

  /** Live-apply budget caps after a Settings save. */
  applyBudget(opts: { dailyRequests?: number; dailyTokens?: number }): void {
    this.budget.update(opts);
  }

  route(hints: TaskHints) {
    // v3: user routing rules from Settings override builtin per-task-type rules.
    // issue #7: the consent gate travels with the registry so every path (rules, explicit
    // hints, fallback chain) can only ever select an agent the user confirmed.
    const merged = getMerged();
    return route(this.registry, hints, merged.routing.rules, {
      isConfigured: (id) => configuredAgent(id, merged),
    });
  }

  status() {
    const merged = getMerged();
    // issue #7: "the user never confirmed this" must be distinguishable from "disabled" and
    // from "no credentials" — the console and the MCP status tool both read this.
    return this.registry.statusList().map((row) => ({
      ...row,
      enabled: merged.agents[row.agent]?.enabled !== false,
      configured: configuredAgent(row.agent, merged),
    }));
  }

  async ask(optsIn: AskOptions): Promise<AgentResult> {
    const t0 = Date.now();
    // issue #11: a named preset fills in the fields the caller left unset (explicit fields win).
    const opts = optsIn.preset ? (applyPreset(optsIn, optsIn.preset) as AskOptions) : optsIn;
    const settings = getMerged();

    // v3: disabled agents fail loudly on explicit hints (no silent reroute)...
    if (opts.agent && settings.agents[opts.agent]?.enabled === false) {
      return {
        agent: opts.agent, ok: false, text: '',
        error: `agent ${opts.agent} 已在设置中禁用（设置 → Agents）`,
        toolCalls: 0, durationMs: Date.now() - t0,
      };
    }
    // issue #7: a never-confirmed agent is refused for the same reason a disabled one is —
    // explicitly, and with instructions rather than a silent swap to somebody else.
    if (opts.agent && !configuredAgent(opts.agent, settings)) {
      return {
        agent: opts.agent, ok: false, text: '',
        error: `agent ${opts.agent} 尚未确认启用：请先运行首启向导，或在「设置 → Agents」中确认（装好 adapter 包不等于同意运行它）`,
        toolCalls: 0, durationMs: Date.now() - t0,
      };
    }
    this.budget.checkRequest();

    // LLM routing for ambiguous tasks: no explicit agent AND no matching rule hint.
    let taskType = opts.taskType;
    let llmReason: string | undefined;
    if (!taskType && !opts.agent && !opts.model && settings.routing.llmRouter !== false) {
      const cls = await classifyTask(this, opts.task, opts.cwd);
      if (cls) { taskType = cls.taskType; llmReason = `llm:${cls.reason}`; }
    }
    const decision = this.route({
      agent: opts.agent,
      model: opts.model,
      effort: opts.effort,
      mode: opts.mode,
      taskType,
      tier: opts.tier,
      requirements: { differentVendorFrom: opts.differentVendorFrom },
    });
    if (llmReason) decision.reason = `${decision.reason} [${llmReason}]`;

    // v3: user-configured per-agent defaults outrank matrix defaults; explicit per-call hints win over both.
    const agS = settings.agents[decision.agent];
    if (agS?.defaults) {
      if (!opts.model && agS.defaults.model) decision.model = agS.defaults.model;
      if (!opts.effort && agS.defaults.effort) decision.effort = agS.defaults.effort;
      if (!opts.mode && agS.defaults.mode) decision.mode = agS.defaults.mode;
    }

    // Workspace (Phase 3): shared cwd or isolated per-agent git worktree.
    // B5/C8 (audit): worktree failures are NOT silent — either error out (explicit request) or record why.
    let ws: PreparedWorkspace | undefined;
    let effCwd = opts.cwd;
    let workspaceNote: string | undefined;
    if (opts.workspaceMode === 'worktree') {
      try {
        ws = await prepareWorkspace({
          repoDir: opts.cwd, agent: decision.agent, mode: 'worktree',
          baseDir: settings.workspace.worktreeBaseDir ?? undefined,
        });
        effCwd = ws.path;
        this.worktrees.add(ws);
      } catch (e: any) {
        workspaceNote = `worktree preparation failed, fell back to shared cwd: ${String(e?.message ?? e).slice(0, 200)}`;
      }
    }

    const finalTask = opts.verdict ? opts.task + verdictInstruction() : opts.task;

    // D2: fallback chain — retry transport-class failures on the next candidate.
    // v3: disabled agents are skipped in fallback chains (...and never silently chosen).
    const isEnabled = (a: AgentId) => settings.agents[a]?.enabled !== false;
    const useFallback = opts.fallback ?? true;
    const chain: AgentId[] = isEnabled(decision.agent) ? [decision.agent] : [];
    if (useFallback) for (const a of decision.fallbackChain) if (a !== decision.agent && !chain.includes(a) && isEnabled(a)) chain.push(a);

    let r: AgentResult | undefined;
    const attempts: string[] = [];
    for (const agent of chain) {
      r = agent === 'dsh'
        ? await this.runDsh(finalTask, { cwd: effCwd, timeoutMs: opts.timeoutMs, onEvent: opts.onEvent }, t0, decision)
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
        error: 'all fallback candidates failed',
        toolCalls: 0, durationMs: Date.now() - t0,
      };
    }
    // F3 (issue #2): the fallback trail is diagnostic, never the job's error. A successful
    // job (r.ok) must not carry `error` — the console renders it in red and consumers key
    // off it to judge the result. The trail lives in its own field.
    if (attempts.length) r.fallbackTrail = attempts.join(' | ');

    r.workspace = ws
      ? { kind: ws.kind, path: ws.path, branch: ws.branch }
      : { kind: 'shared', path: opts.cwd };
    if (workspaceNote) r.workspaceNote = workspaceNote;
    // issue #11: expose the tier resolution structurally — a caller (especially an MCP client)
    // must be able to tell "preference satisfied" from "fell back to the default" without
    // regex-scraping the human-readable reason.
    if (decision.tierRequested) { r.tierRequested = decision.tierRequested; r.tierMatched = decision.tierMatched; }
    this.budget.record(r.usage, r.agent);
    return r;
  }

  review(opts: {
    task: string; cwd: string; excludeVendors: string[];
    model?: string; effort?: string; timeoutMs?: number; verdict?: boolean;
    onEvent?: (e: { kind: 'text' | 'tool' | 'tool_result' | 'thinking' | 'status'; text?: string; status?: string }) => void;
  }) {
    return this.ask({ ...opts, taskType: 'review', differentVendorFrom: opts.excludeVendors, verdict: opts.verdict ?? true });
  }

  // Phase 4: full implementation -> cross-vendor review -> neutral verification -> arbitration.
  heteroReview(opts: HeteroReviewOptions): Promise<HeteroReviewOutcome> {
    return runHeteroReview(this, opts);
  }

  // Phase 5: native fan-out/fan-in batch (fractal/CAO replacement on Windows — see batch/parallel.ts).
  parallel(jobs: ParallelJob[], concurrency?: number, onEvent?: (e: { jobId: string; kind: string; text?: string }) => void): Promise<ParallelOutcome> {
    return runParallel(this, jobs, concurrency, onEvent);
  }

  async send(agent: AgentId, sessionId: string, task: string, timeoutMs?: number,
    onEvent?: (e: { kind: 'text' | 'tool' | 'tool_result' | 'thinking' | 'status'; text?: string; status?: string }) => void,
    opts?: { model?: string; effort?: string }): Promise<AgentResult> {
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
      // effort applies per turn on dsh (the --patch overlay); model has no external channel.
      const r = await DshDriver.run(task, { cwd, sessionId, timeoutMs: timeoutMs ?? 300_000, profile: dshProfileOf(), onEvent, effort: opts?.effort });
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
    // A per-turn model/effort change on a live session (chat settings): apply before running.
    if (opts?.model || opts?.effort) {
      try { await this.applyConfigToSession(s, agent, opts); } catch { /* best-effort */ }
    }
    const driver = this.acpDriver(agent);
    const outcome = await driver.run(s, task, { timeoutMs: timeoutMs ?? 300_000, onEvent });
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

  /**
   * Apply model/effort to a LIVE acp session (used when chat settings change mid-conversation).
   * If the adapter died with the process, a fresh turn respawns it anyway.
   */
  async applySessionConfig(agent: AgentId, sessionId: string, cfg: { model?: string; effort?: string }): Promise<{ applied: ConfigApplyRecord[] }> {
    const s = this.sessions.get(`${agent}:${sessionId}`);
    if (!s) return { applied: [] };
    return { applied: await this.applyConfigToSession(s, agent, cfg) };
  }

  /** dsh keeps its sessions in ITS own store; after a console restart the resume handle only
   *  needs the cwd back to keep talking to the same conversation. */
  adoptDshSession(sessionId: string, cwd: string): void {
    this.dshSessions.set(sessionId, cwd);
  }

  /** Shared by runAcp/applySessionConfig — resolves the option id the way the adapter
   *  advertises it (effort often lives under a `thought_level` category). */
  private async applyConfigToSession(s: AcpSession, agent: AgentId,
    cfg: { model?: string; effort?: string }): Promise<ConfigApplyRecord[]> {
    const applied: ConfigApplyRecord[] = [];
    const driver = this.acpDriver(agent);
    const resolveOptionId = (kind: 'model' | 'effort'): string | undefined => {
      if (s.configOptions.some((c) => c.id === kind)) return kind;
      if (kind === 'effort') {
        const byCategory = s.configOptions.find((c) => c.category === 'thought_level');
        if (byCategory) return byCategory.id;
      }
      return undefined;
    };
    const pairs: Array<['model' | 'effort', string | undefined]> = [['model', cfg.model], ['effort', cfg.effort]];
    for (const [kind, value] of pairs) {
      if (!value) continue;
      const id = resolveOptionId(kind);
      if (!id) { applied.push({ id: kind, value, ok: false, via: 'option-not-offered', error: 'agent did not advertise this config option' }); continue; }
      const cur = s.configOptions.find((c) => c.id === id)?.currentValue;
      if (cur === value) { applied.push({ id, value, ok: true, via: 'already-set' }); continue; }
      applied.push({ id, value, ...(await driver.setConfig(s, id, value)) });
    }
    return applied;
  }

  async stop(agent: AgentId, sessionId: string): Promise<{ stopped: boolean }> {
    // dsh is a one-shot process: there is no live child to cancel, but "stopping" it means
    // dropping the resume handle so send() can no longer continue that session.
    if (agent === 'dsh') {
      const had = this.dshSessions.delete(sessionId);
      return { stopped: had };
    }
    const key = `${agent}:${sessionId}`;
    const s = this.sessions.get(key);
    if (!s) return { stopped: false };
    const d = this.acpDriver(agent);
    try { await d.cancel(s); } catch { /* best-effort cancel */ }
    // F1 (issue #2): a kept session is now owned by stop() — cancel AND reclaim it,
    // else the child process leaks and listSessions() would report a dead session.
    this.sessions.delete(key);
    try { await s.rpc.close(); } catch { /* noop */ }
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
      const cfg = resolveAgentConfig(agent);
      d = AcpDriver.from({ agent, command: cfg.command, args: cfg.args });
      this.drivers.set(agent, d);
    }
    return d;
  }

  private async runDsh(task: string, o: { cwd: string; timeoutMs?: number; onEvent?: (e: { kind: 'text' | 'tool' | 'tool_result' | 'thinking' | 'status'; text?: string; status?: string }) => void }, t0: number,
    decision: { effort?: string; model?: string }): Promise<AgentResult> {
    const r = await DshDriver.run(task, { cwd: o.cwd, timeoutMs: o.timeoutMs, onEvent: o.onEvent, profile: dshProfileOf(), effort: decision.effort });
    if (r.sessionId && r.exitCode === 0) this.dshSessions.set(r.sessionId, o.cwd);

    // C4 (audit): report only what verifiably took effect. Effort now HAS a channel on dsh —
    // a `--patch` overlay pinning agent-default-model.config.reasoningEffort (see dsh-driver);
    // `ok` means the overlay made it into argv, which is what the driver can prove.
    const applied: ConfigApplyRecord[] = [];
    if (decision.effort) {
      applied.push(r.effortApplied
        ? { id: 'reasoning_effort', value: decision.effort, ok: true, via: 'profile-patch' }
        : { id: 'reasoning_effort', value: decision.effort, ok: false, via: 'not-supported', error: r.effortError ?? 'reasoning effort was not applied' });
    }
    // Model still has no channel: headless takes no model flag, and the overlay's model id must
    // be dsh's own (`deepseek-flash`), which the registry does not carry. Reported, not guessed.
    if (decision.model) {
      applied.push({ id: 'model', value: decision.model, ok: false, via: 'not-supported', error: 'dsh headless has no external model flag; set it in the dsh profile' });
    }

    return {
      agent: 'dsh',
      model: ControlPlane.effective(applied, 'model'),
      effort: ControlPlane.effective(applied, 'effort'),
      sessionId: r.sessionId,
      ok: r.exitCode === 0, text: r.text || `(dsh exit=${r.exitCode}) ${r.stderr.slice(-500)}`,
      stopReason: r.exitCode === 0 ? 'end_turn' : 'error', toolCalls: 0,
      durationMs: Date.now() - t0,
      usage: r.usage,
      applied,
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
        // v3: inject the agent's resolved credential (secrets.env / env) into the child env —
        // only the referenced name, per the audit's env whitelist.
        const cfg = resolveAgentConfig(agent);
        const cred = cfg.credentialRef ? getCredential(cfg.credentialRef) : undefined;
        rpc = await driver.connect(o.cwd, cred && cfg.credentialRef ? { [cfg.credentialRef]: cred.value } : undefined);
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

        const lim = agentSettingsOf(agent)?.limits;
        const outcome = await driver.run(session, task, {
          timeoutMs: o.opts.timeoutMs ?? lim?.timeoutMs ?? 300_000,
          maxToolCalls: o.opts.maxToolCalls ?? lim?.maxToolCalls ?? undefined,
          onEvent: o.opts.onEvent,
        });
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
        // F1 (issue #2): honour keepSession — a kept session must stay in the map and
        // keep its child process alive, otherwise spawn_agent/send_agent/stop_agent are
        // all unreachable. Teardown is then owned by stop() / shutdown().
        if (session && o.keep) {
          // Intentionally left live. The caller (or shutdown) owns it now.
        } else if (session) {
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

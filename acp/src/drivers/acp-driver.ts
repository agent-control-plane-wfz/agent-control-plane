// ACP driver — one implementation, configured per agent (opencode/claude/codex).
// Verified against Phase 0: all three expose model/effort as session configOptions.
import { JsonRpcStdio } from '../core/jsonrpc.ts';
import type { AgentId, ConfigOption } from '../core/types.ts';

export interface AcpAgentConfig {
  agent: AgentId;
  command: string;
  args: string[];
}

export interface AcpSession {
  rpc: JsonRpcStdio;
  sessionId: string;
  configOptions: ConfigOption[];
  raw: any;
}

export interface RunOutcome {
  text: string;
  stopReason?: string;
  toolCalls: number;
  updates: any[];
  usage: { input?: number; output?: number; cachedRead?: number; thinking?: number };
}

export class AcpDriver {
  readonly cfg: AcpAgentConfig;

  private constructor(cfg: AcpAgentConfig) {
    this.cfg = cfg;
  }

  static from(cfg: AcpAgentConfig): AcpDriver {
    return new AcpDriver(cfg);
  }

  async connect(cwd: string): Promise<JsonRpcStdio> {
    const rpc = new JsonRpcStdio(this.cfg.command, this.cfg.args, cwd, `acp:${this.cfg.agent}`);
    const init = await rpc.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    }, 30_000);
    rpc.notify('initialized');
    (rpc as any).__initResult = init;
    return rpc;
  }

  async newSession(rpc: JsonRpcStdio, cwd: string): Promise<AcpSession> {
    const res = await rpc.request('session/new', { cwd, mcpServers: [] }, 60_000);
    return {
      rpc,
      sessionId: res.sessionId,
      configOptions: (res.configOptions ?? []) as ConfigOption[],
      raw: res,
    };
  }

  // Verified against adapter sources (2026-10-07): claude-agent-acp & codex-acp both take
  // session/set_config_option { sessionId, configId, value } -> { configOptions }.
  // Fallbacks kept for other/future ACP implementations; mode also accepts session/set_mode.
  async setConfig(s: AcpSession, id: string, value: string): Promise<{ ok: boolean; via: string; error?: string }> {
    const attempts: Array<[string, any]> = [
      ['session/set_config_option', { sessionId: s.sessionId, configId: id, value }],
      ['session/set_config_option', { sessionId: s.sessionId, optionId: id, value }],
      ['session/set_config_option', { sessionId: s.sessionId, id, value }],
      ['session/set_config', { sessionId: s.sessionId, options: { [id]: value } }],
    ];
    if (id === 'mode') attempts.push(['session/set_mode', { sessionId: s.sessionId, modeId: value }]);
    if (id === 'model') attempts.push(['session/set_model', { sessionId: s.sessionId, modelId: value }]);
    let lastErr = 'no attempt made';
    for (const [method, params] of attempts) {
      try {
        await s.rpc.request(method, params, 15_000);
        return { ok: true, via: method };
      } catch (e: any) {
        lastErr = String(e?.message ?? e);
        if (lastErr.includes('timeout')) return { ok: false, via: method, error: lastErr };
      }
    }
    return { ok: false, via: 'none', error: lastErr };
  }

  // Run a task: session/prompt with a long timeout, collecting session/update stream.
  // maxToolCalls: hard per-call gate — cancels the session when exceeded (stopReason='budget_tool_calls').
  async run(s: AcpSession, task: string, opts: { timeoutMs?: number; maxToolCalls?: number } = {}): Promise<RunOutcome> {
    const timeoutMs = opts.timeoutMs ?? 300_000;
    const outcome: RunOutcome = { text: '', stopReason: undefined, toolCalls: 0, updates: [], usage: {} };
    let cancelled = false;
    const prevHandler = s.rpc.onNotification;
    s.rpc.onNotification = (method, params) => {
      if (prevHandler) prevHandler(method, params);
      if (method !== 'session/update' || params?.sessionId !== s.sessionId) return;
      const u = params.update ?? {};
      outcome.updates.push(u);
      const kind = u.sessionUpdate ?? u.type ?? '';
      if (String(kind).includes('agent_message')) {
        const block = u.content ?? u.contentBlock;
        const t = typeof block === 'string' ? block : (block?.text ?? '');
        if (t) outcome.text += t;
      } else if (String(kind).includes('tool_call')) {
        outcome.toolCalls++;
        if (opts.maxToolCalls && outcome.toolCalls >= opts.maxToolCalls && !cancelled) {
          cancelled = true;
          s.rpc.notify('session/cancel', { sessionId: s.sessionId });
        }
      }
      // Token usage — shape varies by agent; accumulate leniently.
      const usage = u.usage ?? u.tokenUsage ?? (String(kind).includes('token_usage') ? u : undefined);
      if (usage && typeof usage === 'object') {
        const num = (v: any) => (typeof v === 'number' ? v : undefined);
        const acc = (k: string, v?: number) => { if (v !== undefined) (outcome.usage as any)[k] = ((outcome.usage as any)[k] ?? 0) + v; };
        acc('input', num(usage.inputTokens) ?? num(usage.input) ?? num(usage.input_tokens));
        acc('output', num(usage.outputTokens) ?? num(usage.output) ?? num(usage.output_tokens));
        acc('cachedRead', num(usage.cachedReadTokens) ?? num(usage.cache_read_input_tokens) ?? num(usage.cached));
        acc('thinking', num(usage.thinkingTokens) ?? num(usage.thinking_tokens) ?? num(usage.reasoning_tokens));
      }
    };
    try {
      const res = await s.rpc.request('session/prompt', {
        sessionId: s.sessionId,
        prompt: [{ type: 'text', text: task }],
      }, timeoutMs);
      outcome.stopReason = res?.stopReason;
      if (!outcome.text && res?.text) outcome.text = res.text;
    } finally {
      s.rpc.onNotification = prevHandler;
    }
    if (cancelled) outcome.stopReason = 'budget_tool_calls';
    return outcome;
  }

  async cancel(s: AcpSession): Promise<void> {
    s.rpc.notify('session/cancel', { sessionId: s.sessionId });
  }
}

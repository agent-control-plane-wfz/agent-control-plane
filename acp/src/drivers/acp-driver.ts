// ACP driver — one implementation, configured per agent (opencode/claude/codex).
// Verified against Phase 0: all three expose model/effort as session configOptions.
import { JsonRpcStdio } from '../core/jsonrpc.ts';
import { resolveCli } from '../core/resolve-cli.ts';
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

  async connect(cwd: string, extraEnv?: Record<string, string>): Promise<JsonRpcStdio> {
    // A portable configured command (`opencode`) has to be resolved to something spawn()
    // can execute — on Windows a PATH shim is a `.cmd`, which spawn rejects outright.
    const cli = resolveCli(this.cfg.command);
    const rpc = new JsonRpcStdio(cli.command, [...cli.prefixArgs, ...this.cfg.args], cwd, `acp:${this.cfg.agent}`, extraEnv);
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
  // onEvent: live progress callback (text chunks / tool calls / thought chunks) for UIs.
  async run(s: AcpSession, task: string, opts: {
    timeoutMs?: number; maxToolCalls?: number;
    onEvent?: (e: { kind: 'text' | 'tool' | 'tool_result' | 'thinking' | 'status'; text?: string; status?: string }) => void;
  } = {}): Promise<RunOutcome> {
    const timeoutMs = opts.timeoutMs ?? 300_000;
    const outcome: RunOutcome = { text: '', stopReason: undefined, toolCalls: 0, updates: [], usage: {} };
    let cancelled = false;
    let lastMessageId: string | undefined;
    const seenToolCalls = new Set<string>();
    const seenToolEnds = new Set<string>();
    // B1 (audit): `tool_call` (start) and `tool_call_update` (progress) both exist; count each
    // real call once by toolCallId. `agent_message_chunk` appends; `agent_message` REPLACES
    // the accumulated text for the same messageId (C2).
    const prevHandler = s.rpc.onNotification;
    s.rpc.onNotification = (method, params) => {
      if (prevHandler) prevHandler(method, params);
      if (method !== 'session/update' || params?.sessionId !== s.sessionId) return;
      const u = params.update ?? {};
      outcome.updates.push(u);
      const kind = String(u.sessionUpdate ?? u.type ?? '');

      if (kind === 'agent_message_chunk') {
        const block = u.content ?? u.contentBlock;
        const t = typeof block === 'string' ? block : (block?.text ?? '');
        if (t) { outcome.text += t; opts.onEvent?.({ kind: 'text', text: t }); }
      } else if (kind === 'agent_thought_chunk' || kind === 'thought_chunk') {
        // Chain of thought used to be dropped here; the UI wants to show the agent THINKING,
        // not just its answer. Clamped per chunk like the dsh side.
        const block = u.content ?? u.contentBlock;
        const t = typeof block === 'string' ? block : (block?.text ?? '');
        if (t) opts.onEvent?.({ kind: 'thinking', text: String(t).slice(0, 1500) });
      } else if (kind === 'agent_message') {
        const block = u.content ?? u.contentBlock;
        const t = typeof block === 'string' ? block : (block?.text ?? '');
        const mid = u.messageId;
        if (mid && mid === lastMessageId) outcome.text = t || outcome.text; // replace same-message content
        else if (t) outcome.text = outcome.text ? `${outcome.text}\n${t}` : t;
        if (mid) lastMessageId = mid;
      } else if (kind === 'tool_call') {
        const id = String(u.toolCallId ?? u.id ?? outcome.updates.length);
        if (!seenToolCalls.has(id)) {
          seenToolCalls.add(id);
          outcome.toolCalls++;
          opts.onEvent?.({ kind: 'tool', text: String(u.title ?? u.toolName ?? u.name ?? u.kind ?? 'tool') });
          if (opts.maxToolCalls && outcome.toolCalls >= opts.maxToolCalls && !cancelled) {
            cancelled = true;
            s.rpc.notify('session/cancel', { sessionId: s.sessionId });
          }
        }
      } else if (kind === 'tool_call_update') {
        // A call updates many times; only the terminal transition is worth an event, and only
        // once per call id. The digest is clamped — tool output can be megabytes.
        const id = String(u.toolCallId ?? u.id ?? '');
        const st = String(u.status ?? '');
        if (id && (st === 'completed' || st === 'failed') && !seenToolEnds.has(id)) {
          seenToolEnds.add(id);
          const c = u.content ?? u.rawOutput ?? u.result ?? '';
          const text = typeof c === 'string' ? c
            : Array.isArray(c) ? c.map((x: any) => x?.text ?? '').join(' ')
            : '';
          opts.onEvent?.({
            kind: 'tool_result',
            text: String(text).replace(/\s+/g, ' ').trim().slice(0, 220),
            status: st === 'failed' ? 'error' : 'completed',
          });
        }
      } else if (kind === 'usage_update') {
        // C1 (audit): protocol-shaped usage — { used, size, cost } (plus lenient fallbacks).
        const usage = u.usage ?? u;
        const num = (v: any) => (typeof v === 'number' ? v : undefined);
        const acc = (k: string, v?: number) => { if (v !== undefined) (outcome.usage as any)[k] = ((outcome.usage as any)[k] ?? 0) + v; };
        acc('input', num(usage.used) ?? num(usage.inputTokens) ?? num(usage.input) ?? num(usage.input_tokens));
        acc('output', num(usage.outputTokens) ?? num(usage.output) ?? num(usage.output_tokens));
        acc('cachedRead', num(usage.cachedReadTokens) ?? num(usage.cache_read_input_tokens) ?? num(usage.cached));
        acc('thinking', num(usage.thinkingTokens) ?? num(usage.thinking_tokens) ?? num(usage.reasoning_tokens));
        if (typeof usage.cost === 'number') {
          const prev = (outcome.usage as any).cost ?? 0;
          (outcome.usage as any).cost = prev + usage.cost;
        }
      } else if (u.usage ?? u.tokenUsage) {
        // Lenient fallback for agents that attach usage to other update kinds.
        const usage = u.usage ?? u.tokenUsage;
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

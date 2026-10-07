// Settings (v3): four-layer config precedence, highest first —
//   ① user config   state/control-plane-config.json  (written by the Settings UI; gitignored)
//   ② env           deployment-level (WORKSPACE_DIR, ACP_DAILY_*, ACP_LLM_ROUTER)
//   ③ measured      registry/capability-matrix.json  (DECLARED facts, checked in)
//                   + state/capability-observed.json (OBSERVED on this machine; F2, issue #2)
//   ④ code defaults (this file)
// Facts and preferences stay separate: the UI edits layer ①, the probe button writes
// observed facts into layer ③'s state half — never into the tracked matrix.
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { USER_CONFIG_FILE, REPO_ROOT } from './paths.ts';

export { USER_CONFIG_FILE };

export type Transport = 'acp' | 'json-process';

export interface AgentSettings {
  enabled?: boolean;
  transport?: Transport;
  command?: string;
  args?: string[];
  credentialRef?: string | null;   // env-var NAME only; the value lives in secrets.env / env
  credentialNative?: string;       // description of the agent's own auth (e.g. ~/.codex/auth.json)
  defaults?: { model?: string; effort?: string; mode?: string };
  limits?: { maxToolCalls?: number | null; timeoutMs?: number | null };
  modelOverrides?: Record<string, { vendor?: string; tier?: string }>;
}

export interface RoutingSettings {
  rules?: Record<string, { agent?: string; effort?: string }>;
  llmRouter?: boolean;
}

export interface BudgetSettings { dailyRequests?: number; dailyTokens?: number }
export interface WorkspaceSettings { recentCwds?: string[]; worktreeBaseDir?: string | null }

export interface AppSettings {
  agents: Record<string, AgentSettings>;
  routing: RoutingSettings;
  budget: BudgetSettings;
  workspace: WorkspaceSettings;
}

const BUILTIN_IDS = ['opencode', 'claude', 'codex', 'dsh'] as const;

function workspaceDir(): string {
  const ws = process.env.WORKSPACE_DIR;
  if (!ws) {
    throw new Error(
      'WORKSPACE_DIR is not set. Point it to the directory containing the harness packages '
      + '(@agentclientprotocol/claude-agent-acp, @agentclientprotocol/codex-acp, @deepseek-ai/dsh under node_modules/).',
    );
  }
  return ws;
}

// Layer ④: code defaults for builtin agents (derived from the same sources plane used before).
function matrixOpencodeCommand(): string {
  try {
    const m = JSON.parse(readFileSync(join(REPO_ROOT, 'registry', 'capability-matrix.json'), 'utf8'));
    const c = m.agents?.opencode?.command as string | undefined;
    return c ? c.split(' acp')[0] : 'opencode';
  } catch { return 'opencode'; }
}

export function builtinDefaults(): Record<string, AgentSettings> {
  const out: Record<string, AgentSettings> = {
    opencode: {
      enabled: true, transport: 'acp', command: matrixOpencodeCommand(), args: ['acp'],
      credentialRef: null, credentialNative: 'opencode 内置账号（本机已登录）',
      defaults: {}, limits: {},
    },
  };
  const ws = process.env.WORKSPACE_DIR;
  const node = process.execPath;
  if (ws) {
    const nm = join(ws, 'node_modules');
    out.claude = {
      enabled: true, transport: 'acp', command: node,
      args: [join(nm, '@agentclientprotocol', 'claude-agent-acp', 'dist', 'index.js')],
      credentialRef: 'ANTHROPIC_API_KEY', credentialNative: '~/.claude 登录态（本机已重映射到 DeepSeek 端点）',
      defaults: {}, limits: {},
    };
    out.codex = {
      enabled: true, transport: 'acp', command: node,
      args: [join(nm, '@agentclientprotocol', 'codex-acp', 'dist', 'index.js')],
      credentialRef: 'OPENAI_API_KEY', credentialNative: '~/.codex/auth.json（ChatGPT 登录）',
      defaults: {}, limits: {},
    };
    out.dsh = {
      enabled: true, transport: 'json-process', command: node,
      args: [join(nm, '@deepseek-ai', 'dsh', 'lib', 'bin.js')],
      credentialRef: 'DEEPSEEK_API_KEY', credentialNative: '~/.dsh/.credentials.yaml',
      defaults: {}, limits: {},
    };
  }
  return out;
}

// Layer ②: env-derived sections.
function envLayer(): Partial<AppSettings> {
  const routing: RoutingSettings = {};
  if (process.env.ACP_LLM_ROUTER !== undefined) routing.llmRouter = process.env.ACP_LLM_ROUTER !== '0';
  const budget: BudgetSettings = {};
  if (process.env.ACP_DAILY_REQUESTS) budget.dailyRequests = Number(process.env.ACP_DAILY_REQUESTS) || undefined;
  if (process.env.ACP_DAILY_TOKENS) budget.dailyTokens = Number(process.env.ACP_DAILY_TOKENS) || undefined;
  return { routing, budget };
}

export function loadUserConfig(): { config: Partial<AppSettings>; error?: string } {
  if (!existsSync(USER_CONFIG_FILE)) return { config: {} };
  try {
    return { config: JSON.parse(readFileSync(USER_CONFIG_FILE, 'utf8')) as Partial<AppSettings> };
  } catch (e: any) {
    // Plan §5: broken config falls back to defaults with a visible error — never silent.
    return { config: {}, error: `user config unreadable (${String(e?.message ?? e).slice(0, 120)}); defaults in effect` };
  }
}

function mergeAgent(base: AgentSettings | undefined, over: AgentSettings | undefined): AgentSettings {
  if (!over) return base ?? {};
  return {
    ...base,
    ...Object.fromEntries(Object.entries(over).filter(([, v]) => v !== undefined)),
    defaults: { ...(base?.defaults ?? {}), ...(over.defaults ?? {}) },
    limits: { ...(base?.limits ?? {}), ...(over.limits ?? {}) },
    modelOverrides: { ...(base?.modelOverrides ?? {}), ...(over.modelOverrides ?? {}) },
  } as AgentSettings;
}

export function getMerged(): AppSettings {
  const { config } = loadUserConfig();
  const defaults = builtinDefaults();
  const agents: Record<string, AgentSettings> = {};
  for (const id of BUILTIN_IDS) agents[id] = mergeAgent(defaults[id], config.agents?.[id]);
  for (const [id, cfg] of Object.entries(config.agents ?? {})) {
    // F10 (issue #2): hasOwnProperty, not a truthiness check — `agents['__proto__']` would
    // be truthy on any object and silently swallow a (now-rejected) reserved id.
    if (!Object.prototype.hasOwnProperty.call(agents, id)) agents[id] = mergeAgent(undefined, cfg); // custom agents
  }
  const env = envLayer();
  return {
    agents,
    routing: { llmRouter: env.routing?.llmRouter ?? true, rules: config.routing?.rules ?? {} },
    budget: {
      dailyRequests: config.budget?.dailyRequests ?? env.budget?.dailyRequests,
      dailyTokens: config.budget?.dailyTokens ?? env.budget?.dailyTokens,
    },
    workspace: {
      recentCwds: config.workspace?.recentCwds ?? [],
      worktreeBaseDir: config.workspace?.worktreeBaseDir ?? null,
    },
  };
}

// --- validation: save is refused with a field-level reason; nothing is written otherwise.
// F10 (issue #2): the id space must be an allowlist. `[\s/\\]` let `__proto__`,
// `constructor` and `prototype` through; today getMerged()'s `if (!agents[id])` happens to
// block them (all three are truthy on {}), but that is an accident, not a guarantee.
const RESERVED_IDS = ['__proto__', 'constructor', 'prototype'];
export function isValidAgentId(id: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(id) && !RESERVED_IDS.includes(id);
}

function validate(patch: Partial<AppSettings>): string | null {
  if (patch.agents) {
    for (const [id, a] of Object.entries(patch.agents)) {
      if (!isValidAgentId(id)) return `agents.${id}: 非法 id（只允许字母/数字/下划线/连字符，且不得为保留名）`;
      if (!a || typeof a !== 'object') return `agents.${id}: 必须是对象`;
      if (a.enabled !== undefined && typeof a.enabled !== 'boolean') return `agents.${id}.enabled: 必须是布尔`;
      if (a.transport !== undefined && !['acp', 'json-process'].includes(a.transport)) return `agents.${id}.transport: 只能是 acp 或 json-process`;
      if (a.command !== undefined && typeof a.command !== 'string') return `agents.${id}.command: 必须是字符串`;
      if (a.args !== undefined && (!Array.isArray(a.args) || a.args.some((x) => typeof x !== 'string'))) return `agents.${id}.args: 必须是字符串数组`;
      if (a.credentialRef !== undefined && a.credentialRef !== null && (typeof a.credentialRef !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(a.credentialRef))) return `agents.${id}.credentialRef: 必须是合法环境变量名或 null`;
      if (a.limits?.maxToolCalls !== undefined && a.limits.maxToolCalls !== null && (typeof a.limits.maxToolCalls !== 'number' || a.limits.maxToolCalls < 1)) return `agents.${id}.limits.maxToolCalls: 必须 >= 1`;
      if (a.limits?.timeoutMs !== undefined && a.limits.timeoutMs !== null && (typeof a.limits.timeoutMs !== 'number' || a.limits.timeoutMs < 1000)) return `agents.${id}.limits.timeoutMs: 必须 >= 1000`;
    }
  }
  if (patch.budget) {
    for (const k of ['dailyRequests', 'dailyTokens'] as const) {
      const v = patch.budget[k];
      if (v !== undefined && v !== null && (typeof v !== 'number' || v < 0)) return `budget.${k}: 必须 >= 0`;
    }
  }
  if (patch.routing) {
    if (patch.routing.llmRouter !== undefined && typeof patch.routing.llmRouter !== 'boolean') return 'routing.llmRouter: 必须是布尔';
    if (patch.routing.rules) {
      for (const [k, r] of Object.entries(patch.routing.rules)) {
        if (!['quick', 'code', 'reasoning', 'review'].includes(k)) return `routing.rules.${k}: 未知任务类型`;
        if (!r || typeof r !== 'object' || (r.agent !== undefined && typeof r.agent !== 'string')) return `routing.rules.${k}: 结构错误`;
      }
    }
  }
  if (patch.workspace?.worktreeBaseDir !== undefined && patch.workspace.worktreeBaseDir !== null && typeof patch.workspace.worktreeBaseDir !== 'string') return 'workspace.worktreeBaseDir: 必须是字符串或 null';
  return null;
}

function atomicWrite(file: string, content: string): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, file);
}

/** Deep-merge patch into the user layer, validate, atomic write. Throws on validation failure. */
export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const err = validate(patch);
  if (err) throw new Error(err);
  const cur = loadUserConfig().config;
  const next: Partial<AppSettings> = {
    agents: { ...(cur.agents ?? {}), ...(patch.agents ?? {}) },
    routing: {
      ...cur.routing,
      ...(patch.routing ?? {}),
      // rules use REPLACE semantics (removing a key = back to builtin default)
      rules: patch.routing?.rules ?? cur.routing?.rules,
    },
    budget: { ...(cur.budget ?? {}), ...(patch.budget ?? {}) },
    workspace: { ...(cur.workspace ?? {}), ...(patch.workspace ?? {}) },
  };
  mkdirSync(dirname(USER_CONFIG_FILE), { recursive: true });
  atomicWrite(USER_CONFIG_FILE, JSON.stringify(next, null, 2));
  return getMerged();
}

/** Remove a whole section (or one agent) from the user layer — 恢复默认. */
export function resetSettings(section: 'agents' | 'routing' | 'budget' | 'workspace', sub?: string): AppSettings {
  const cur = loadUserConfig().config;
  if (section === 'agents' && sub) {
    // F10 (issue #2): only delete an OWN key — a bare `delete agents[sub]` with sub='__proto__'
    // (or 'constructor') would otherwise reach into the prototype chain.
    const agents = { ...(cur.agents ?? {}) };
    if (Object.prototype.hasOwnProperty.call(agents, sub)) delete agents[sub];
    atomicWrite(USER_CONFIG_FILE, JSON.stringify({ ...cur, agents }, null, 2));
  } else {
    const next = { ...cur } as Record<string, unknown>;
    delete next[section];
    atomicWrite(USER_CONFIG_FILE, JSON.stringify(next, null, 2));
  }
  return getMerged();
}

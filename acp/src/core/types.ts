// Core types — Phase 1. Only erasable syntax (no enum/namespace) for Node 22 --experimental-strip-types.

// Builtin ids keep autocomplete; arbitrary ids allow user-configured custom agents (v3 settings).
export type BuiltinAgentId = 'opencode' | 'claude' | 'codex' | 'dsh';
export type AgentId = BuiltinAgentId | (string & {});

export interface SpawnSpec {
  agent: AgentId;
  task: string;
  cwd: string;
  model?: string;
  effort?: string;
  mode?: string;
  timeoutMs?: number;
}

export interface TokenUsage {
  input?: number;
  output?: number;
  cachedRead?: number;
  thinking?: number;
}

export interface ConfigApplyRecord {
  id: string;
  value?: string;
  ok: boolean;
  via: string;
  error?: string;
}

export interface AgentResult {
  agent: AgentId;
  model?: string;
  effort?: string;
  sessionId?: string;
  ok: boolean;
  text: string;
  stopReason?: string;
  error?: string;
  toolCalls: number;
  durationMs: number;
  usage?: TokenUsage;
  applied?: ConfigApplyRecord[];
  verdict?: import('./verdict.ts').Verdict;   // present when ask(verdict:true)
  verdictError?: string;
  workspace?: { kind: 'shared' | 'worktree'; path: string; branch?: string };
  workspaceNote?: string;  // present when a requested worktree fell back to shared cwd
  /** issue #11: structured tier resolution (mirrors RouteDecision); absent when no tier asked. */
  tierRequested?: string;
  tierMatched?: boolean;
  fallbackTrail?: string;  // F3 (issue #2): diagnostic only — never mirrored into `error`
}

export interface RouteDecision {
  agent: AgentId;
  model?: string;
  effort?: string;
  mode?: string;
  reason: string;
  /** issue #11: present only when a tier was requested — callers must not parse `reason`. */
  tierRequested?: string;
  /** true = a model of that tier was found; false = fell back to the agent default. */
  tierMatched?: boolean;
  fallbackChain: AgentId[];
}

export interface AgentStatusSummary {
  agent: AgentId;
  transport: 'acp' | 'json-process' | 'cli-process';
  authenticated: boolean | 'unknown';
  models: string[];
  effortLevels: string[];
  actualVendorNote?: string;
  /** issue #7: the user's consent switch. Absent on registry-only callers (no settings layer). */
  enabled?: boolean;
  configured?: boolean;
}

// Raw shapes observed in Phase 0 (capability-matrix.json)
export interface ConfigOption {
  id: string;
  name: string;
  category?: string;
  type: string;
  currentValue?: string;
  options?: Array<{ value: string; name: string; description?: string }>;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

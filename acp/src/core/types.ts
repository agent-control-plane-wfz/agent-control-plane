// Core types — Phase 1. Only erasable syntax (no enum/namespace) for Node 22 --experimental-strip-types.

export type AgentId = 'opencode' | 'claude' | 'codex' | 'dsh';

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
}

export interface RouteDecision {
  agent: AgentId;
  model?: string;
  effort?: string;
  mode?: string;
  reason: string;
  fallbackChain: AgentId[];
}

export interface AgentStatusSummary {
  agent: AgentId;
  transport: 'acp' | 'json-process' | 'cli-process';
  authenticated: boolean | 'unknown';
  models: string[];
  effortLevels: string[];
  actualVendorNote?: string;
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

// Router v0 — rules only (LLM stub left for Phase 2).
// Order: explicit hints -> capability filter -> heterogeneity constraint -> fallback chain.
import type { AgentId, RouteDecision, Registry as IRegistry } from '../core/types.ts';
import type { Registry } from '../registry/registry.ts';

export interface TaskHints {
  agent?: AgentId;
  model?: string;
  effort?: string;
  mode?: string;
  taskType?: 'quick' | 'code' | 'reasoning' | 'review';
  requirements?: { differentVendorFrom?: string[] };
}

const RULES: Record<NonNullable<TaskHints['taskType']>, { agent: AgentId; tier?: string; effort?: string; note: string }> = {
  quick:     { agent: 'opencode', effort: 'default', note: 'cheap/fast pool for mechanical work' },
  code:      { agent: 'codex',    effort: 'medium',  note: 'workhorse coding model' },
  reasoning: { agent: 'codex',    effort: 'xhigh',   note: 'deep reasoning for hard analysis' },
  review:    { agent: 'claude',   effort: 'high',    note: 'reviewer defaults to claude adapter (vendor checked at runtime)' },
};

const FALLBACK: AgentId[] = ['codex', 'claude', 'opencode', 'dsh'];

export function route(reg: Registry, hints: TaskHints): RouteDecision {
  const chain: AgentId[] = [];
  const push = (d: RouteDecision) => ({ ...d, fallbackChain: chain.slice() });

  // 1. Explicit agent hint wins (validated against matrix).
  if (hints.agent) {
    if (!reg.get(hints.agent)) throw new Error(`unknown agent: ${hints.agent}`);
    if (reg.requiresAuth(hints.agent) === true) {
      chain.push(hints.agent);
    } else {
      return push({
        agent: hints.agent,
        model: hints.model ?? reg.defaultModel(hints.agent),
        effort: hints.effort ?? reg.defaultEffort(hints.agent),
        mode: hints.mode,
        reason: 'explicit agent hint',
      });
    }
  }

  // 2. Heterogeneity constraint: exclude agents whose ACTUAL vendor is in the exclusion list.
  let excludeVendors = hints.requirements?.differentVendorFrom ?? [];
  const candidates: AgentId[] = [];
  const ordered: AgentId[] = hints.taskType && RULES[hints.taskType]
    ? [RULES[hints.taskType].agent, ...FALLBACK]
    : FALLBACK;
  for (const a of ordered) {
    if (!candidates.includes(a)) candidates.push(a);
  }
  const viable = candidates.filter((a) => {
    const entry = reg.get(a);
    if (!entry) return false;
    if (reg.requiresAuth(a) === true) return false;          // no creds -> not viable now
    if (excludeVendors.length && reg.agentsExcludingVendors([]).includes(a)) {
      // check vendor after picking model (actual vendor depends on model)
    }
    return true;
  });

  const pick = viable[0];
  if (!pick) {
    throw new Error(`no viable agent (all filtered: auth/heterogeneity). excludeVendors=${JSON.stringify(excludeVendors)}`);
  }

  // 3. Heterogeneity: if the picked agent's actual vendor collides, walk the fallback chain.
  let chosen = pick;
  let model = hints.model ?? reg.defaultModel(chosen);
  let reason = hints.taskType ? `rule:${hints.taskType} (${RULES[hints.taskType].note})` : 'fallback order';
  if (excludeVendors.length) {
    const okVendor = (a: AgentId, m?: string) => !excludeVendors.includes(reg.actualVendor(a, m));
    let found = false;
    for (const a of viable) {
      const m = hints.model ?? reg.defaultModel(a);
      if (okVendor(a, m)) { chosen = a; model = m; found = true; break; }
      chain.push(a);
    }
    if (!found) throw new Error(`heterogeneity unsatisfiable: every candidate vendor in ${JSON.stringify(excludeVendors)}`);
    reason += ` + differentVendorFrom(${JSON.stringify(excludeVendors)})`;
  } else {
    // build chain for reporting
    for (const a of viable.slice(1)) chain.push(a);
  }

  return push({
    agent: chosen,
    model,
    effort: hints.effort ?? reg.defaultEffort(chosen),
    mode: hints.mode,
    reason,
  });
}

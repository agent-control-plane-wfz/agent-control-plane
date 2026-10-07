// Router v0.2 — rules first (LLM fallback lives in llm-router.ts).
// Order: explicit hints -> capability filter -> heterogeneity constraint (fail-closed) -> fallback chain.
import type { AgentId, RouteDecision } from '../core/types.ts';
import type { Registry } from '../registry/registry.ts';

export interface TaskHints {
  agent?: AgentId;
  model?: string;
  effort?: string;
  mode?: string;
  taskType?: 'quick' | 'code' | 'reasoning' | 'review';
  requirements?: { differentVendorFrom?: string[] };
}

const RULES: Record<NonNullable<TaskHints['taskType']>, { agent: AgentId; effort?: string; note: string }> = {
  quick:     { agent: 'opencode', effort: 'default', note: 'cheap/fast pool for mechanical work' },
  code:      { agent: 'codex',    effort: 'medium',  note: 'workhorse coding model' },
  reasoning: { agent: 'codex',    effort: 'xhigh',   note: 'deep reasoning for hard analysis' },
  review:    { agent: 'claude',   effort: 'high',    note: 'reviewer defaults to claude adapter (vendor checked at runtime)' },
};

// v3: user rules from Settings override the builtins per task type.
export const BUILTIN_RULES = RULES;
export type RoutingRuleOverride = { agent?: string; effort?: string };

export function route(reg: Registry, hints: TaskHints, rulesOverride?: Record<string, RoutingRuleOverride>): RouteDecision {
  const chain: AgentId[] = [];
  const push = (d: Omit<RouteDecision, 'fallbackChain'>) => ({ ...d, fallbackChain: chain.slice() });
  const ruleFor = (t: NonNullable<TaskHints['taskType']>) => {
    const o = rulesOverride?.[t];
    if (o?.agent) return { agent: o.agent as AgentId, effort: o.effort ?? RULES[t].effort, note: 'user rule (Settings)' };
    return RULES[t];
  };

  // 1. Explicit agent hint is a HARD constraint (B5, audit): if the user asked for a
  //    specific agent and it is unavailable, that is an error — never a silent swap.
  if (hints.agent) {
    if (!reg.get(hints.agent)) throw new Error(`unknown agent: ${hints.agent}`);
    if (reg.requiresAuth(hints.agent) === true) {
      throw new Error(
        `agent '${hints.agent}' was explicitly requested but has no working credentials `
        + `(registry status: ${reg.get(hints.agent)?.auth?.status ?? 'unknown'}). `
        + 'Configure its credentials or omit the agent hint to allow routing.',
      );
    }
    return push({
      agent: hints.agent,
      model: hints.model ?? reg.defaultModel(hints.agent),
      effort: hints.effort ?? reg.defaultEffort(hints.agent),
      mode: hints.mode,
      reason: 'explicit agent hint',
    });
  }

  // 2. Candidate chain from task-type rule, then generic fallback order.
  const FALLBACK: AgentId[] = ['codex', 'claude', 'opencode', 'dsh'];
  const activeRule = hints.taskType ? ruleFor(hints.taskType) : undefined;
  const ordered: AgentId[] = activeRule ? [activeRule.agent, ...FALLBACK] : FALLBACK;
  const candidates: AgentId[] = [];
  for (const a of ordered) if (!candidates.includes(a)) candidates.push(a);

  // 3. B4 (audit): heterogeneity is FAIL-CLOSED. An agent whose actual vendor is
  //    'unknown' can never satisfy a differentVendorFrom constraint — otherwise the
  //    "implementer != reviewer" guarantee silently degrades to guesswork.
  const excludeVendors = hints.requirements?.differentVendorFrom ?? [];
  const okVendor = (a: AgentId, m?: string) => {
    const v = reg.actualVendor(a, m);
    return v !== 'unknown' && !excludeVendors.includes(v);
  };

  const viable = candidates.filter((a) => {
    if (!reg.get(a)) return false;
    if (reg.requiresAuth(a) === true) return false;
    if (excludeVendors.length && !okVendor(a, hints.model ?? reg.defaultModel(a))) return false;
    return true;
  });

  const pick = viable[0];
  if (!pick) {
    const why = excludeVendors.length
      ? ` (heterogeneity excludeVendors=${JSON.stringify(excludeVendors)} — agents with unknown vendor are excluded by fail-closed policy)`
      : '';
    throw new Error(`no viable agent available${why}`);
  }

  const chosen = pick;
  const model = hints.model ?? reg.defaultModel(chosen);
  let reason = hints.taskType ? `rule:${hints.taskType} (${activeRule?.note ?? 'default'})` : 'fallback order';
  if (excludeVendors.length) reason += ` + differentVendorFrom(${JSON.stringify(excludeVendors)}) [fail-closed]`;

  for (const a of viable.slice(1)) chain.push(a);

  return push({
    agent: chosen,
    model,
    effort: hints.effort ?? reg.defaultEffort(chosen),
    mode: hints.mode,
    reason,
  });
}

// Router v0.3 — rules first (LLM fallback lives in llm-router.ts).
// Order: consent gate -> explicit hints -> capability filter -> heterogeneity (fail-closed) -> fallback chain.
import type { AgentId, RouteDecision } from '../core/types.ts';
import type { Registry } from '../registry/registry.ts';

export interface TaskHints {
  agent?: AgentId;
  model?: string;
  effort?: string;
  mode?: string;
  taskType?: 'quick' | 'code' | 'reasoning' | 'review';
  /** issue #11: prefer a model of this tier for the chosen agent. */
  tier?: string;
  requirements?: { differentVendorFrom?: string[] };
}

export interface RouteOptions {
  /**
   * User-consent gate (issue #7). Only a confirmed agent may be routed to or used as a fallback.
   * Omitted by callers that have no settings layer (e.g. pure-logic tests), in which case the
   * gate is not applied.
   */
  isConfigured?: (id: AgentId) => boolean;
}

// issue #11: builtin rules intentionally carry NO tier. Adding one would change which model every
// existing deployment picks by default, and that is not a change to make blind — the tiers in the
// table are declared facts that a probe can contradict. A tier therefore takes effect only where a
// user rule or preset asks for one; the defaults stay exactly as they were.
const RULES: Record<NonNullable<TaskHints['taskType']>, { agent: AgentId; effort?: string; tier?: string; note: string }> = {
  quick:     { agent: 'opencode', effort: 'default', note: 'cheap/fast pool for mechanical work' },
  code:      { agent: 'codex',    effort: 'medium',  note: 'workhorse coding model' },
  reasoning: { agent: 'codex',    effort: 'xhigh',   note: 'deep reasoning for hard analysis' },
  review:    { agent: 'claude',   effort: 'high',    note: 'reviewer defaults to claude adapter (vendor checked at runtime)' },
};

// v3: user rules from Settings override the builtins per task type.
export const BUILTIN_RULES = RULES;
export type RoutingRuleOverride = { agent?: string; effort?: string; tier?: string };

/**
 * issue #11: resolve the model for a chosen agent. A tier is a PREFERENCE against this machine's
 * table; an explicit model always wins; an unsatisfiable tier falls back to the agent default and
 * SAYS SO (the note goes into the route reason) instead of pretending the preference was honoured.
 * Shared by the explicit-hint path and the rule/fallback path so the two cannot drift apart.
 */
function pickModel(reg: Registry, agent: AgentId, hints: TaskHints, ruleTier?: string): { model?: string; tierNote?: string } {
  const wantTier = hints.tier ?? ruleTier;
  const tierModel = wantTier && hints.model === undefined ? reg.modelsByTier(agent, wantTier)[0] : undefined;
  const model = hints.model ?? tierModel ?? reg.defaultModel(agent);
  if (!wantTier) return { model };
  return {
    model,
    tierNote: tierModel
      ? `tier:${wantTier} -> ${tierModel}`
      : `tier:${wantTier} 未匹配（${agent} 的模型表里没有该档位），已用其默认模型 ${model ?? '(未配置)'}`,
  };
}

export function route(reg: Registry, hints: TaskHints, rulesOverride?: Record<string, RoutingRuleOverride>, options?: RouteOptions): RouteDecision {
  const chain: AgentId[] = [];
  const push = (d: Omit<RouteDecision, 'fallbackChain'>) => ({ ...d, fallbackChain: chain.slice() });
  const ruleFor = (t: NonNullable<TaskHints['taskType']>) => {
    const o = rulesOverride?.[t];
    if (o?.agent) return { agent: o.agent as AgentId, effort: o.effort ?? RULES[t].effort, tier: o.tier, note: 'user rule (Settings)' };
    return RULES[t];
  };
  const configured = (a: AgentId) => !options?.isConfigured || options.isConfigured(a);

  // 1. Explicit agent hint is a HARD constraint (B5, audit): if the user asked for a
  //    specific agent and it is unavailable, that is an error — never a silent swap.
  //    Consent is checked first (issue #7): "never confirmed" is a more actionable diagnosis
  //    than "no credentials", because the user has not opted in at all yet.
  if (hints.agent) {
    if (!reg.get(hints.agent)) throw new Error(`unknown agent: ${hints.agent}`);
    if (!configured(hints.agent)) {
      throw new Error(
        `agent '${hints.agent}' was explicitly requested but has not been confirmed on this machine. `
        + 'Confirm it via the first-run wizard or Settings → Agents (installing an adapter package '
        + 'is not consent to run it).',
      );
    }
    if (reg.requiresAuth(hints.agent) === true) {
      // Issue #6: cite the actual basis — credential evidence — instead of the declared matrix
      // field, which no longer takes part in this decision.
      throw new Error(
        `agent '${hints.agent}' was explicitly requested but has no working credentials: `
        + 'no credential evidence found on this machine '
        + '(checked its credentialRef env var / state/secrets.env and its own login files). '
        + 'Configure its credentials, or omit the agent hint to allow routing.',
      );
    }
    const explicit = pickModel(reg, hints.agent, hints);
    return push({
      agent: hints.agent,
      model: explicit.model,
      effort: hints.effort ?? reg.defaultEffort(hints.agent),
      mode: hints.mode,
      reason: `explicit agent hint${explicit.tierNote ? ` + ${explicit.tierNote}` : ''}`,
    });
  }

  // 2. Candidate chain from task-type rule, then the generic fallback order.
  // F9 (issue #2): derive the fallback order from the registry instead of a hardcoded
  // builtin list — otherwise a custom agent could never be a fallback candidate. Builtins
  // keep their stable, tuned order; custom agents follow, sorted for determinism.
  const BUILTIN_ORDER: AgentId[] = ['codex', 'claude', 'opencode', 'dsh'];
  const registered = Object.keys(reg.matrix.agents) as AgentId[];
  const FALLBACK: AgentId[] = [
    ...BUILTIN_ORDER.filter((a) => registered.includes(a)),
    ...registered.filter((a) => !BUILTIN_ORDER.includes(a)).sort(),
  ];
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
    if (!configured(a)) return false;   // issue #7: consent gate
    if (reg.requiresAuth(a) === true) return false;
    if (excludeVendors.length && !okVendor(a, hints.model ?? reg.defaultModel(a))) return false;
    return true;
  });

  const pick = viable[0];
  if (!pick) {
    // Failure must be actionable: "nothing is confirmed yet" and "the constraint is
    // unsatisfiable" need different fixes, and a headless caller has no UI to discover it.
    const confirmedCount = candidates.filter(configured).length;
    const why = confirmedCount === 0
      ? ' — no agent has been confirmed on this machine yet. Run the first-run wizard '
        + '(or confirm one in Settings → Agents); a detected adapter is not enough.'
      : excludeVendors.length
        ? ` (heterogeneity excludeVendors=${JSON.stringify(excludeVendors)} — agents with unknown vendor are excluded by fail-closed policy)`
        : '';
    throw new Error(`no viable agent available${why}`);
  }

  const chosen = pick;
  // issue #11: a tier is a PREFERENCE resolved against this machine's table — an explicit model
  // hint always wins, and if the tier cannot be satisfied we say so in `reason` rather than
  // silently pretending the preference was honoured.
  const picked = pickModel(reg, chosen, hints, activeRule?.tier);
  const model = picked.model;
  let reason = hints.taskType ? `rule:${hints.taskType} (${activeRule?.note ?? 'default'})` : 'fallback order';
  if (picked.tierNote) reason += ` + ${picked.tierNote}`;
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

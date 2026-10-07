// Capability Registry v0 — declared facts from capability-matrix.json (Phase 0 measured
// data, checked in) merged with observed facts from the state dir (F2, issue #2: probe
// results are machine-local, so they must not be written into a tracked file).
//
// Issue #6: authentication is answered from credential EVIDENCE, not from a probe's
// `reachable` verdict — a handshake does not validate credentials. See requiresAuth().
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentId, AgentStatusSummary } from '../core/types.ts';
import { OBSERVED_FILE, MODELS_OBSERVED_FILE } from '../config/paths.ts';

const here = dirname(fileURLToPath(import.meta.url));

export type AuthEvidenceState = 'present' | 'absent' | 'unknown';

export interface AgentEntry {
  transport: 'acp' | 'json-process' | 'cli-process';
  command?: string;
  version_tested?: string;
  auth?: { status?: string; methods_advertised?: string[]; needed?: string };
  capabilities?: any;
  configOptions_observed?: Record<string, any>;
  windows?: any;
  open_questions?: string[];
}

export interface ModelEntry {
  vendor: string;
  tier: 'frontier' | 'strong' | 'fast' | 'cheap';
  traits: string[];
  via: AgentId;
  note?: string;
}

export class Registry {
  matrix: { agents: Record<string, AgentEntry> };
  models: { models: Record<string, ModelEntry>; agentDefaults: Record<string, { model?: string; effort?: string | null; vendorPool?: string }> };
  private matrixPath: string;
  private modelsPath: string;
  private observedPath: string;
  private modelsObservedPath: string;
  private observed: Record<string, Partial<AgentEntry>> = {};
  private authEvidence?: (id: AgentId) => AuthEvidenceState | undefined;

  constructor(matrixPath?: string, modelsPath?: string, observedPath?: string, modelsObservedPath?: string) {
    this.matrixPath = matrixPath ?? process.env.ACP_MATRIX_FILE ?? join(here, '..', '..', '..', 'registry', 'capability-matrix.json');
    this.modelsPath = modelsPath ?? join(here, 'models.json');
    this.observedPath = observedPath ?? process.env.ACP_OBSERVED_FILE ?? OBSERVED_FILE;
    this.modelsObservedPath = modelsObservedPath ?? process.env.ACP_MODELS_OBSERVED_FILE ?? MODELS_OBSERVED_FILE;
    this.matrix = JSON.parse(readFileSync(this.matrixPath, 'utf8'));
    this.models = JSON.parse(readFileSync(this.modelsPath, 'utf8'));
    this.loadModelsObserved();
    this.loadObserved();
    this.applyObserved();
  }

  /**
   * Inject machine-local credential evidence (issue #6). The ControlPlane wires this to
   * config/auth-evidence.ts so that "does this agent need auth" reflects what is true HERE
   * rather than a snapshot recorded on someone else's machine — and so a successful handshake
   * can never be mistaken for authentication.
   */
  setAuthEvidence(fn: ((id: AgentId) => AuthEvidenceState | undefined) | undefined): void {
    this.authEvidence = fn;
  }

  /** The injected credential evidence for this agent ('unknown' when no channel can decide). */
  authEvidenceState(agentId: AgentId): AuthEvidenceState {
    return this.authEvidence?.(agentId) ?? 'unknown';
  }

  /** Per-machine model overlay (e.g. an adapter remapped to another vendor) over the declared table. */
  private loadModelsObserved(): void {
    try {
      if (!existsSync(this.modelsObservedPath)) return;
      const obs = JSON.parse(readFileSync(this.modelsObservedPath, 'utf8')) as Partial<Registry['models']>;
      this.models.models = { ...this.models.models, ...(obs.models ?? {}) };
      this.models.agentDefaults = { ...this.models.agentDefaults, ...(obs.agentDefaults ?? {}) };
    } catch { /* corrupt/unreadable -> declared table only */ }
  }

  private loadObserved(): void {
    try {
      if (existsSync(this.observedPath)) {
        this.observed = (JSON.parse(readFileSync(this.observedPath, 'utf8')) as { agents?: Record<string, Partial<AgentEntry>> }).agents ?? {};
      }
    } catch { /* corrupt/unreadable -> declared facts only */ }
  }

  /** Declared-then-observed: observed fields win only where the probe actually recorded something. */
  private applyObserved(): void {
    for (const [id, obs] of Object.entries(this.observed)) {
      const declared = this.matrix.agents[id] ?? { transport: (obs as AgentEntry).transport ?? 'acp' };
      const merged: AgentEntry = { ...declared };
      if (obs.auth) merged.auth = obs.auth;
      if (obs.configOptions_observed) merged.configOptions_observed = obs.configOptions_observed;
      if (obs.command) merged.command = obs.command;
      this.matrix.agents[id] = merged;
    }
  }

  /** Re-read matrix + models + observed after a probe has written new observations. */
  reload(): void {
    this.matrix = JSON.parse(readFileSync(this.matrixPath, 'utf8'));
    this.models = JSON.parse(readFileSync(this.modelsPath, 'utf8'));
    this.loadModelsObserved();
    this.loadObserved();
    this.applyObserved();
  }

  get(agentId: AgentId): AgentEntry | undefined {
    return this.matrix.agents[agentId];
  }

  defaultModel(agentId: AgentId): string | undefined {
    return this.models.agentDefaults[agentId]?.model;
  }

  defaultEffort(agentId: AgentId): string | undefined {
    const e = this.models.agentDefaults[agentId]?.effort;
    return e === null ? undefined : e;
  }

  // Vendor of the model the agent would ACTUALLY run (Phase 0 lesson: adapter name != vendor).
  // D2 (audit): returns 'unknown' when the model is not in the table — callers must treat
  // unknown as unsatisfiable for heterogeneity constraints (fail-closed in router.ts).
  actualVendor(agentId: AgentId, model?: string): string {
    const key = model ? `${agentId}/${model}` : `${agentId}/${this.defaultModel(agentId) ?? ''}`;
    const entry = this.models.models[key];
    return entry ? entry.vendor : 'unknown';
  }

  /**
   * issue #11: the `tier` field on every model entry was never read by anything. These are the
   * accessors that make it usable: pick a model of a wanted tier instead of hard-coding an id that
   * may not exist on this machine. Deterministic (table order), matching the project's rule that
   * facts come from the table rather than from guesswork.
   */
  modelsByTier(agentId: AgentId, tier: string): string[] {
    return Object.entries(this.models.models)
      .filter(([, m]) => m.via === agentId && m.tier === tier)
      .map(([k]) => k.split('/').slice(1).join('/'));
  }

  /** Tier of the model an agent would actually use (undefined = not in the table). */
  modelTier(agentId: AgentId, model?: string): string | undefined {
    const key = model ? `${agentId}/${model}` : `${agentId}/${this.defaultModel(agentId) ?? ''}`;
    return this.models.models[key]?.tier;
  }

  /**
   * Reasoning-effort levels this agent can be asked for.
   *
   * Two admissible sources, in priority order:
   *
   *  1. `configOptions_observed` — a REAL observation, written only by the ACP probe path
   *     (initialize + session/new return live configOptions).
   *  2. `capabilities.reasoning_effort` — a DECLARED fact in the matrix, for transports that
   *     have no ACP handshake to observe. dsh runs as `json-process`; its probe branch only
   *     checks `--help`'s exit code, so no configOptions are ever collected for it and the
   *     observed source is structurally always empty. Before this fallback the console showed
   *     dsh with zero effort levels while dsh in fact supports four.
   *
   * The fallback deliberately reads the DECLARED block rather than fabricating an entry under
   * `configOptions_observed`: that field means "observed", and writing an unobserved value there
   * is the same category error issue #6 removed from the auth path.
   */
  effortOptions(agentId: AgentId, model?: string): string[] {
    const e = this.get(agentId);
    const eff = e?.configOptions_observed?.effort ?? e?.configOptions_observed?.reasoning_effort;
    const observed: string[] | undefined = eff?.options;
    if (observed?.length) return observed;
    const declared = e?.capabilities?.reasoning_effort;
    return Array.isArray(declared?.options) ? declared.options : [];
  }

  supportsConfig(agentId: AgentId, optionId: 'model' | 'effort'): boolean {
    const e = this.get(agentId);
    const obs = e?.configOptions_observed ?? {};
    if (optionId === 'model') return 'model' in obs;
    // A declared capability counts here too (see effortOptions) — otherwise dsh would advertise
    // four levels while answering "I can't do effort", and callers keying off this would refuse.
    return 'effort' in obs || 'reasoning_effort' in obs || e?.capabilities?.reasoning_effort?.supported === true;
  }

  /**
   * Does this agent lack usable credentials? (false = it can authenticate, true = it cannot.)
   *
   * EVIDENCE ONLY (issue #6). Neither input that used to answer this question is admissible:
   *
   *  - the declared matrix `auth.status` is a snapshot from ONE machine (README: "某台机器的实测
   *    快照"), so trusting it elsewhere is the same class of error as the probe rubber-stamp —
   *    and it drifts in BOTH directions (its stale `not-configured` silently rerouted away from a
   *    working agent; its stale `authenticated` would route to a broken one);
   *  - a probe's `reachable` verdict only proves the process starts; `initialize` + `session/new`
   *    do not validate credentials.
   *
   * So the answer comes from config/auth-evidence.ts (env/secrets + real credential files), and
   * when no channel can decide we say 'unknown' — callers treat that as "not positively known to
   * be broken" (the Router only excludes on `true`), so a working agent is never dropped, while a
   * positively-missing credential IS caught before a prompt is wasted on it.
   */
  requiresAuth(agentId: AgentId): boolean | 'unknown' {
    const ev = this.authEvidence?.(agentId);
    if (ev === 'present') return false;
    if (ev === 'absent') return true;
    return 'unknown';
  }

  statusList(): AgentStatusSummary[] {
    const out: AgentStatusSummary[] = [];
    for (const [id, e] of Object.entries(this.matrix.agents)) {
      const agent = id as AgentId;
      // FIX (P1): requiresAuth() answers "does this agent NEED auth" (false = already
      // authenticated). This field is named `authenticated`, so invert it — otherwise every
      // authenticated agent was reported as unauthenticated and UIs rendered it as an error.
      const needsAuth = this.requiresAuth(agent);
      out.push({
        agent,
        transport: e.transport,
        authenticated: needsAuth === 'unknown' ? 'unknown' : !needsAuth,
        models: this.listModels(agent),
        effortLevels: this.effortOptions(agent),
        actualVendorNote: this.actualVendor(agent),
      });
    }
    return out;
  }

  listModels(agentId: AgentId): string[] {
    return Object.entries(this.models.models)
      .filter(([, m]) => m.via === agentId)
      .map(([k]) => k.split('/').slice(1).join('/'));
  }

  /**
   * Agents that can serve as a heterogeneous counterpart: their ACTUAL vendor is known and is
   * not in `vendors`.
   *
   * FAIL-CLOSED (B4) — an unknown vendor cannot PROVE heterogeneity, so it is excluded rather
   * than assumed different. This mirrors the router's inline `okVendor` check; the method is
   * kept for callers that want the whole list instead of a single pick. (Before issue #6 it
   * returned unknown-vendor agents too, which is a false-heterogeneity trap: the name invites
   * "pick a reviewer from this list", and the vendor could then be the implementer's.)
   */
  agentsExcludingVendors(vendors: string[]): AgentId[] {
    const out: AgentId[] = [];
    for (const [id, e] of Object.entries(this.matrix.agents)) {
      if (e.transport !== 'acp' && e.transport !== 'json-process') continue;
      const vendor = this.actualVendor(id as AgentId);
      if (vendor !== 'unknown' && !vendors.includes(vendor)) out.push(id as AgentId);
    }
    return out;
  }
}

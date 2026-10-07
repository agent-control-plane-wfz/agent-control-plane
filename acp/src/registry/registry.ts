// Capability Registry v0 — single source of truth = capability-matrix.json (Phase 0 measured data).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentId, AgentStatusSummary } from '../core/types.ts';

const here = dirname(fileURLToPath(import.meta.url));

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

  constructor(matrixPath?: string, modelsPath?: string) {
    this.matrixPath = matrixPath ?? process.env.ACP_MATRIX_FILE ?? join(here, '..', '..', '..', 'registry', 'capability-matrix.json');
    this.modelsPath = modelsPath ?? join(here, 'models.json');
    this.matrix = JSON.parse(readFileSync(this.matrixPath, 'utf8'));
    this.models = JSON.parse(readFileSync(this.modelsPath, 'utf8'));
  }

  /** Re-read matrix + models after a probe has written new observations. */
  reload(): void {
    this.matrix = JSON.parse(readFileSync(this.matrixPath, 'utf8'));
    this.models = JSON.parse(readFileSync(this.modelsPath, 'utf8'));
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

  effortOptions(agentId: AgentId, model?: string): string[] {
    const e = this.get(agentId);
    const eff = e?.configOptions_observed?.effort ?? e?.configOptions_observed?.reasoning_effort;
    return eff?.options ?? [];
  }

  supportsConfig(agentId: AgentId, optionId: 'model' | 'effort'): boolean {
    const e = this.get(agentId);
    const obs = e?.configOptions_observed ?? {};
    if (optionId === 'model') return 'model' in obs;
    return 'effort' in obs || 'reasoning_effort' in obs;
  }

  requiresAuth(agentId: AgentId): boolean | 'unknown' {
    const a = this.get(agentId)?.auth;
    const s = a?.status ?? '';
    if (s.startsWith('authenticated')) return false;
    if (s.startsWith('not-configured')) return true;
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

  // Find agents whose ACTUAL vendor differs from all given vendors (heterogeneous review).
  agentsExcludingVendors(vendors: string[]): AgentId[] {
    const out: AgentId[] = [];
    for (const [id, e] of Object.entries(this.matrix.agents)) {
      if (e.transport !== 'acp' && e.transport !== 'json-process') continue;
      const vendor = this.actualVendor(id as AgentId);
      if (!vendors.includes(vendor)) out.push(id as AgentId);
    }
    return out;
  }
}

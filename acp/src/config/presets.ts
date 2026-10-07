// Named (agent, model, effort, tier) presets (issue #11).
//
// The registry has always carried a `tier` on every model entry, and nothing read it — so "give me
// the cheap/fast model for this mechanical task" was unsayable. Presets make a whole routing
// preference nameable ("fast", "deep") and reusable from the console, the MCP tools and config,
// while `tier` lets a rule express the preference without hard-coding a model id that may not
// exist on this machine.
import { getMerged } from './settings.ts';

export type PresetTaskType = 'quick' | 'code' | 'reasoning' | 'review';

export interface Preset {
  agent?: string;
  model?: string;
  effort?: string;
  taskType?: PresetTaskType;
  /** Preference: pick a model of this tier for the chosen agent (see Registry.pickModelByTier). */
  tier?: string;
}

export function listPresets(): Record<string, Preset> {
  return getMerged().presets ?? {};
}

/**
 * Expand a named preset onto a request. Explicit fields on the request always win, so a preset is
 * a set of defaults rather than an override — and an unknown name is an error listing the names
 * that do exist, never a silent no-op (a typo must not quietly dispatch to somebody else).
 */
export function applyPreset<T extends { preset?: string }>(opts: T, name?: string): Omit<T, 'preset'> & Preset {
  const { preset: _drop, ...rest } = opts as T & { preset?: string };
  const key = name ?? (opts as { preset?: string }).preset;
  if (!key) return rest as Omit<T, 'preset'> & Preset;
  const all = listPresets();
  const p = all[key];
  if (!p) {
    const names = Object.keys(all);
    throw new Error(`unknown preset: ${key}（已保存的预设：${names.length ? names.join(', ') : '无'}）`);
  }
  const merged: Record<string, unknown> = { ...p };
  for (const [k, v] of Object.entries(rest)) if (v !== undefined) merged[k] = v;
  return merged as Omit<T, 'preset'> & Preset;
}

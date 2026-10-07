// First-run setup wizard (issue #7) — the layer between "the machine could run this agent" and
// "the user agreed to run it".
//
// Model:
//   detected   — the command resolves and the entry file exists (config/detect.ts)
//   configured — the user confirmed it; the ONLY state the Router accepts
//   reachable  — a handshake succeeded (config/probe.ts); says nothing about credentials
//
// Nothing here performs a prompt, and nothing is written until completeSetup() is called
// explicitly. Credential VALUES are write-only: they go into state/secrets.env via
// setCredential() and are never echoed back by any API.
import { authEvidence, nativeAuthEvidence, type AuthEvidence, type NativeAuthEvidence } from './auth-evidence.ts';
import { detectAgent } from './detect.ts';
import {
  builtinDefaults, clearSetupMarker, configuredAgent, getMerged, isValidAgentId,
  saveSettings, setupState, type AgentSettings, type AppSettings,
} from './settings.ts';
import { setCredential } from './secrets.ts';

export type SetupPhase = 'pending' | 'done' | 'legacy';

export interface SetupCandidate {
  id: string;
  transport: string;
  command?: string;
  args?: string[];
  /** Can this machine run it at all? (machine fact) */
  detected: boolean;
  detection: string;
  credentialRef: string | null;
  credentialNative?: string;
  /** Already confirmed by the user? */
  confirmed: boolean;
  configuredNow: boolean;
  evidence: AuthEvidence;
  nativeAuth: NativeAuthEvidence;
}

export interface SetupView {
  phase: SetupPhase;
  candidates: SetupCandidate[];
  userConfigError?: string;
}

/** What the wizard shows, per candidate. Read-only; no writes. */
export function setupView(): SetupView {
  const merged = getMerged();
  const candidates: SetupCandidate[] = [];
  for (const [id, a] of Object.entries(merged.agents)) {
    const detection = detectAgent(a);
    candidates.push({
      id,
      transport: a.transport ?? 'acp',
      command: a.command,
      args: a.args,
      detected: detection.detected,
      detection: detection.detail,
      credentialRef: a.credentialRef ?? null,
      credentialNative: a.credentialNative,
      confirmed: a.confirmed === true,
      configuredNow: configuredAgent(id, merged),
      evidence: authEvidence(id, a.credentialRef),
      nativeAuth: nativeAuthEvidence(id),
    });
  }
  return { phase: setupState(), candidates };
}

export interface SetupChoice {
  /** true = use this agent; false = explicitly do not. */
  confirm: boolean;
  command?: string;
  args?: string[];
  credentialRef?: string | null;
  /** write-only; stored into state/secrets.env. Empty string clears it. */
  credentialValue?: string;
}

export class SetupError extends Error {}

/**
 * Write the user's answers. Builtins that were not confirmed are recorded as `confirmed: false`
 * (so "we showed it and the user declined" is distinguishable from "we never asked"), and the
 * completion marker is set — which is what stops the wizard from reappearing.
 */
export function completeSetup(choices: Record<string, SetupChoice>): AppSettings {
  const merged = getMerged();
  const patch: Record<string, AgentSettings> = {};

  for (const [id, choice] of Object.entries(choices)) {
    if (!isValidAgentId(id)) throw new SetupError(`非法 agent id：${id}`);
    if (!Object.prototype.hasOwnProperty.call(merged.agents, id)) throw new SetupError(`未知 agent：${id}`);
    if (typeof choice !== 'object' || choice === null) throw new SetupError(`agents.${id}: 必须是对象`);
    const entry: AgentSettings = { confirmed: choice.confirm === true };
    if (choice.command !== undefined) entry.command = String(choice.command);
    if (choice.args !== undefined) {
      if (!Array.isArray(choice.args) || choice.args.some((x) => typeof x !== 'string')) {
        throw new SetupError(`agents.${id}.args: 必须是字符串数组`);
      }
      entry.args = choice.args.map(String);
    }
    if (choice.credentialRef !== undefined) entry.credentialRef = choice.credentialRef;

    // A pasted value is only meaningful with a reference name to store it under.
    if (choice.credentialValue !== undefined && choice.credentialValue !== '') {
      const ref = entry.credentialRef !== undefined ? entry.credentialRef : merged.agents[id].credentialRef;
      if (!ref) throw new SetupError(`agents.${id}: 未指定凭据引用名，无法保存凭据值`);
      if (choice.credentialValue.length > 10_000) throw new SetupError(`agents.${id}: 凭据值过长`);
    }
    patch[id] = entry;
  }

  // Everything else that is a builtin and was shown gets an explicit decision.
  const defaults = builtinDefaults();
  for (const id of Object.keys(defaults)) {
    if (!Object.prototype.hasOwnProperty.call(patch, id)) patch[id] = { confirmed: false };
  }

  // Store credential values only after every input has validated.
  for (const [id, choice] of Object.entries(choices)) {
    if (choice.credentialValue === undefined) continue;
    const ref = (patch[id].credentialRef ?? merged.agents[id].credentialRef) as string | null;
    if (ref) setCredential(ref, choice.credentialValue);
  }

  return saveSettings({ agents: patch, setup: { completedAt: new Date().toISOString() } });
}

/** Re-open the wizard (keeps confirmations and settings; only clears the marker). */
export function rerunSetup(): AppSettings {
  return clearSetupMarker();
}

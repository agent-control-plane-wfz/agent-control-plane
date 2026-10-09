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
//
// issue #7 follow-up: the wizard no longer dumps every builtin on the user. "Installing an
// adapter is not consent" cut both ways — a wall of four pre-checked cards is a different kind
// of presumption: someone who wants ONE harness still has to read past the other three (and
// cancel them, which used to record them as declined). So a fresh machine opens on an EMPTY
// list plus an "add" row, and `setupView()` hands back two collections:
//   candidates — agents the user already took on (confirmed, or written into their own config).
//                Rendered by default, so re-running the wizard shows your existing choices
//                instead of asking you to pick them again.
//   templates  — the builtins that are NOT candidates: add-able building blocks carrying all
//                the prefills (command/args/credentialRef/detection) the card needs.
// Which templates got added is a UI decision and lives in the page until completeSetup() runs;
// nothing here reads or writes that set.
import { authEvidence, nativeAuthEvidence, type AuthEvidence, type NativeAuthEvidence } from './auth-evidence.ts';
import { detectAgent } from './detect.ts';
import {
  builtinDefaults, clearSetupMarker, configuredAgent, getMerged, isValidAgentId, loadUserConfig,
  saveSettings, setupState, type AgentSettings, type AppSettings,
} from './settings.ts';
import { setCredential } from './secrets.ts';

export type SetupPhase = 'pending' | 'done' | 'legacy';

/** One agent as the wizard sees it: machine facts + where its credentials live. */
export interface SetupEntry {
  id: string;
  transport: string;
  command?: string;
  args?: string[];
  /** Run form for JSON-process agents (issue #9); undefined = driver default. */
  profile?: string;
  /** Can this machine run it at all? (machine fact) */
  detected: boolean;
  detection: string;
  credentialRef: string | null;
  credentialNative?: string;
  evidence: AuthEvidence;
  nativeAuth: NativeAuthEvidence;
}

/** An agent the user already took on — shown by default. */
export interface SetupCandidate extends SetupEntry {
  /** Already confirmed by the user? */
  confirmed: boolean;
  configuredNow: boolean;
}

export interface SetupView {
  phase: SetupPhase;
  /** Taken on already: rendered without the user having to add anything. */
  candidates: SetupCandidate[];
  /** Add-able building blocks — everything else the machine could run. */
  templates: SetupEntry[];
  userConfigError?: string;
}

function entryFor(id: string, a: AgentSettings): SetupEntry {
  const detection = detectAgent(a);
  return {
    id,
    transport: a.transport ?? 'acp',
    command: a.command,
    args: a.args,
    profile: a.profile,
    detected: detection.detected,
    detection: detection.detail,
    credentialRef: a.credentialRef ?? null,
    credentialNative: a.credentialNative,
    evidence: authEvidence(id, a.credentialRef),
    nativeAuth: nativeAuthEvidence(id),
  };
}

/** What the wizard shows. Read-only; no writes. */
export function setupView(): SetupView {
  const merged = getMerged();
  const { config } = loadUserConfig();
  const own = config.agents ?? {};
  const candidates: SetupCandidate[] = [];
  const templates: SetupEntry[] = [];
  for (const [id, a] of Object.entries(merged.agents)) {
    const entry = entryFor(id, a);
    // "Already taken on" is about the USER, not about what ships in the code:
    //   confirmed === true                                 — they said yes;
    //   configuredAgent() === true                          — currently usable, which on a
    //       `legacy` machine includes the pre-#7 grandfathering (confirmed stays undefined).
    //       Leaving that out made a legacy machine's wizard open EMPTY while four agents were
    //       actually routable — and completing the empty list revoked every one of them, which is
    //       the opposite of what that machine's note promises ("你的启用状态不会被自动改动").
    //   confirmed === undefined + present in their config   — an agent they wrote by hand.
    // An explicit `confirmed: false` is NOT taken on: the user looked at it and passed, so it
    // goes back into the option pool, where re-adding it is a deliberate act. And a builtin
    // nobody has ever spoken for is a template, nothing more — `confirmed: false` (which
    // completeSetup writes for every builtin it was not asked about) must not turn all four
    // into candidates, which is exactly the "wall of cards" this is undoing.
    const takenOn = configuredAgent(id, merged)
      || (a.confirmed === undefined && Object.prototype.hasOwnProperty.call(own, id));
    if (takenOn) {
      candidates.push({
        ...entry,
        confirmed: a.confirmed === true,
        configuredNow: configuredAgent(id, merged),
      });
    } else {
      templates.push(entry);
    }
  }
  return { phase: setupState(), candidates, templates };
}

export interface SetupChoice {
  /** true = use this agent; false = explicitly do not. */
  confirm: boolean;
  command?: string;
  args?: string[];
  /** issue #9: run form, e.g. dsh's headless/web. */
  profile?: string;
  credentialRef?: string | null;
  /** write-only; stored into state/secrets.env. Empty string clears it. */
  credentialValue?: string;
}

export class SetupError extends Error {}

/**
 * Write the user's answers. Builtins that were not confirmed are recorded as `confirmed: false`
 * (so "we showed it and the user declined" is distinguishable from "we never asked"), and the
 * completion marker is set — which is what stops the wizard from reappearing.
 *
 * The add-row does not change this: the wizard still lays every builtin out as an option, so
 * "not added" remains a decision the user made after seeing it, not an omission. What it does
 * change is the DEFAULT — nothing is picked, nothing is prefilled as "on".
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
    if (choice.profile !== undefined) {
      if (!/^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(String(choice.profile))) {
        throw new SetupError(`agents.${id}.profile: 只能是字母/数字/下划线/连字符，且不得以连字符开头`);
      }
      entry.profile = String(choice.profile);
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

  // Everything else that is a builtin and was offered gets an explicit decision.
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

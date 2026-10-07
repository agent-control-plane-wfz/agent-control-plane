// Credential evidence (issue #6): what actually proves an agent can authenticate ON THIS
// MACHINE. Two false positives motivated this module:
//
//   1. A DIRECTORY existing was treated as a credential. `~/.claude` is created by any run of
//      the adapter (its sessions/ and projects/ live there), so the check confirmed itself:
//      run the adapter once, and the next status read says "native credentials configured".
//      The credential is a FILE (~/.claude/.credentials.json) or the OS keychain, not the dir.
//   2. A successful ACP handshake was recorded as `authenticated`. `initialize` + `session/new`
//      do NOT validate credentials — they only prove the process starts. That turned the
//      "probe" button into a rubber stamp: /api/status reported authenticated: true on a
//      machine with no credentials at all, and the Router would pick an agent that then failed
//      at prompt time (or, worse, fail-closed heterogeneous review believing it was satisfied).
//
// So this module answers with EVIDENCE, and is allowed to answer 'unknown' rather than guess.
// `unknown` must never be rendered as success — see the tri-state handling in the web UI.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getCredential } from './secrets.ts';

export type AuthEvidenceState = 'present' | 'absent' | 'unknown';

export interface AuthEvidence {
  state: AuthEvidenceState;
  /** Evidence that produced a 'present' verdict (human-readable, e.g. 'env:OPENAI_API_KEY'). */
  sources: string[];
  /** Set only when state === 'unknown' — why we refuse to decide. */
  note?: string;
}

export interface NativeAuthEvidence {
  /** true = proof found; false = none found; 'unknown' = this platform may hold it elsewhere. */
  present: boolean | 'unknown';
  detail: string;
}

interface NativeSpec {
  /** Home-relative files whose existence IS credential evidence. */
  files: string[];
  /** Platforms where the credential may live outside a readable file (keychain etc.). */
  opaqueOn?: NodeJS.Platform[];
  /** Set when no file check can ever decide (the agent keeps its own opaque store). */
  opaqueDetail?: string;
  /** Shown when we positively looked and found nothing. */
  absentDetail?: string;
}

// Per-agent native (agent-owned) credential locations. Only paths verified on a real install
// are listed; anything else reports 'unknown' rather than guessing.
const NATIVE: Record<string, NativeSpec> = {
  // opencode keeps its account in its own store (~/.local/share/opencode/opencode.db, sqlite).
  // We cannot read that cheaply, so we decline to judge instead of claiming a credential.
  opencode: { files: [], opaqueDetail: 'opencode 账户存于其自身存储（opencode.db），无法从文件判定' },
  claude: {
    files: ['.claude/.credentials.json'],
    opaqueOn: ['darwin'], // macOS stores Claude credentials in the Keychain
    absentDetail: '未找到 ~/.claude/.credentials.json',
  },
  codex: { files: ['.codex/auth.json'], absentDetail: '未找到 ~/.codex/auth.json' },
  dsh: { files: ['.dsh/.credentials.yaml'], absentDetail: '未找到 ~/.dsh/.credentials.yaml' },
};

/** Evidence from the agent's OWN login (as opposed to the env/secrets seam). */
export function nativeAuthEvidence(agentId: string, home = homedir()): NativeAuthEvidence {
  const spec = NATIVE[agentId];
  if (!spec) {
    // Custom agent: we have no knowledge of where it keeps credentials.
    return { present: 'unknown', detail: '未识别的 agent，无法判定原生凭据' };
  }
  for (const rel of spec.files) {
    const p = join(home, rel);
    if (existsSync(p)) return { present: true, detail: `~/${rel.replace(/\\/g, '/')}` };
  }
  if (spec.opaqueOn?.includes(process.platform)) {
    return { present: 'unknown', detail: '本平台可能将凭据存于系统钥匙串，无法从文件判定' };
  }
  if (spec.opaqueDetail) return { present: 'unknown', detail: spec.opaqueDetail };
  if (!spec.files.length) return { present: 'unknown', detail: '没有可检查的凭据文件位置' };
  return { present: false, detail: spec.absentDetail ?? '未找到原生凭据' };
}

/**
 * Combined verdict: the env/secrets seam (if the agent has a credentialRef) plus the agent's
 * own login. 'present' if ANY real evidence exists; 'absent' only when we positively looked and
 * found nothing; 'unknown' when a channel exists that we cannot inspect.
 */
export function authEvidence(agentId: string, credentialRef?: string | null, home = homedir()): AuthEvidence {
  const sources: string[] = [];
  if (credentialRef) {
    const c = getCredential(credentialRef);
    if (c) sources.push(c.source === 'env' ? `env:${credentialRef}` : `state/secrets.env:${credentialRef}`);
  }
  const native = nativeAuthEvidence(agentId, home);
  if (native.present === true) sources.push(native.detail);
  if (sources.length) return { state: 'present', sources };

  if (native.present === 'unknown') return { state: 'unknown', sources: [], note: native.detail };
  return { state: 'absent', sources: [] };
}

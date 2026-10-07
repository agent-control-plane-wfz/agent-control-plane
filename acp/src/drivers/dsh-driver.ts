// DeepSeek Harness driver — JSONProcessDriver per plan v2.1.
// dsh --profile <profile> [--json] [--session-id <id>] "task"
//   <profile> defaults to headless and is configurable (issue #9) — see DEFAULT_DSH_PROFILE.
// Event schema VERIFIED 2026-10-07 (dsh 0.2.0-rc.2, phase0/dsh-e2e.txt):
//   {"type":"session","sessionId":...,"cwd":...}
//   {"type":"status","phase":"turn_start"|"step_start"|"step_end"|"turn_end",...}
//     step_end carries usage {inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,totalTokens}
//   {"type":"thinking","text":...}
//   {"type":"text","text":...}
//   {"type":"final","text":...}
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { getCredential } from '../config/secrets.ts';

export interface DshRunOutcome {
  sessionId?: string;
  text: string;
  exitCode: number | null;
  events: any[];
  usage: { input?: number; output?: number; cachedRead?: number };
  stderr: string;
}

// Workspace dir may be on another drive — relative join cannot cross drives. Resolved lazily
// and FAIL-LOUD (PR #1 follow-up): no silent fallback to any developer's machine path.
export function dshBinPath(): string {
  const explicit = process.env.DSH_BIN;
  if (explicit) return explicit;
  const ws = process.env.WORKSPACE_DIR;
  if (!ws) {
    throw new Error(
      'cannot locate DeepSeek Harness: set DSH_BIN (path to @deepseek-ai/dsh/lib/bin.js) '
      + 'or WORKSPACE_DIR (the node workspace that has it under node_modules/)',
    );
  }
  return join(ws, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
}

export function dshCommand(): string {
  return process.env.DSH_NODE ?? process.execPath;
}
export function dshArgs(): string[] {
  return [dshBinPath()];
}

// issue #9: the run form was hard-coded as `--profile headless`. dsh ships several profiles
// (desktop / headless / web on this machine), and ACP can only ever drive one that produces a
// stable, pipeable event stream — so the DEFAULT stays headless, but it is no longer a literal:
// it comes from config (Agents page) with DSH_PROFILE as the deployment override.
//
// Deliberately NOT supported: driving the desktop/web profiles. Those are human-facing front ends
// with no structured stdout contract, so wrapping them would mean adding a brittle scraping layer.
// (If the real goal is "reuse the desktop app's login/sessions", that belongs to the credential
// evidence channel — see config/auth-evidence.ts — not to the profile.)
export const DEFAULT_DSH_PROFILE = 'headless';

/**
 * Reject a profile name before it can reach argv: no spaces, no path separators, and it may not
 * START with "-" — otherwise a flag such as "--json" would pass a naive character-class check and
 * land in the value slot of --profile.
 */
export function assertProfileName(profile: string): void {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_-]*$/.test(profile)) {
    throw new Error(
      `invalid dsh profile name: ${JSON.stringify(profile)} `
      + '(must start with a letter, digit or "_", then letters/digits/"_"/"-" only)',
    );
  }
}

/**
 * The exact argv this driver spawns. Exported so tests can assert the profile/argv contract
 * without spawning anything (see tests/unit/dsh-argv.test.ts).
 */
export function dshArgv(opts: { profile?: string; sessionId?: string; task?: string } = {}): string[] {
  const profile = opts.profile ?? DEFAULT_DSH_PROFILE;
  assertProfileName(profile);
  const args = [dshBinPath(), '--profile', profile, '--json'];
  if (opts.sessionId) args.push('--session-id', opts.sessionId);
  if (opts.task !== undefined) args.push(opts.task);
  return args;
}

export class DshDriver {
  // One-shot run (headless is stateless apart from --session-id adoption).
  static async run(
    task: string,
    opts: {
      cwd: string; sessionId?: string; timeoutMs?: number; profile?: string;
      onEvent?: (e: { kind: 'text' | 'tool' | 'status'; text?: string }) => void;
    },
  ): Promise<DshRunOutcome> {
    // issue #9: no hard-coded profile — see dshArgv(). An unknown profile is passed through and
    // dsh's own failure is surfaced verbatim (never a silent fallback to headless).
    const args = dshArgv({ profile: opts.profile, sessionId: opts.sessionId, task });

    return new Promise((resolve) => {
      const cred = getCredential('DEEPSEEK_API_KEY');
      const child = spawn(dshCommand(), args, {
        cwd: opts.cwd,
        windowsHide: true,
        env: { ...process.env, ...(cred ? { DEEPSEEK_API_KEY: cred.value } : {}) },
      });
      const rl = createInterface({ input: child.stdout });
      const events: any[] = [];
      let stderr = '';
      let finalText = '';
      let streamText = '';
      let sessionId = opts.sessionId;
      const usage: { input?: number; output?: number; cachedRead?: number } = {};

      const timer = setTimeout(() => child.kill(), opts.timeoutMs ?? 300_000);

      rl.on('line', (line) => {
        const s = line.trim();
        if (!s || !s.startsWith('{')) return;
        let ev: any;
        try { ev = JSON.parse(s); } catch { return; }
        events.push(ev);
        switch (ev.type) {
          case 'session':
            sessionId = ev.sessionId ?? sessionId;
            break;
          case 'thinking':
            opts.onEvent?.({ kind: 'status', text: `思考中：${String(ev.text ?? '').slice(0, 80)}` });
            break;
          case 'text':
            streamText += ev.text ?? '';
            opts.onEvent?.({ kind: 'text', text: String(ev.text ?? '') });
            break;
          case 'final':
            finalText = ev.text ?? finalText;
            break;
          case 'status':
            if (ev.phase === 'turn_start') opts.onEvent?.({ kind: 'status', text: '开始处理' });
            if (ev.phase === 'step_end' && ev.usage && typeof ev.usage === 'object') {
              usage.input = (usage.input ?? 0) + (ev.usage.inputTokens ?? 0);
              usage.output = (usage.output ?? 0) + (ev.usage.outputTokens ?? 0);
              usage.cachedRead = (usage.cachedRead ?? 0) + (ev.usage.cacheReadTokens ?? 0);
            }
            break;
        }
      });
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('error', (e) => {
        clearTimeout(timer);
        resolve({ sessionId, text: '', exitCode: null, events, usage, stderr: stderr + String(e) });
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        resolve({
          sessionId,
          text: (finalText || streamText).trim(),
          exitCode: code,
          events,
          usage,
          stderr: stderr.slice(-4000),
        });
      });
    });
  }
}

// DeepSeek Harness driver — JSONProcessDriver per plan v2.1.
// dsh --profile <profile> [--patch <overlay.yml>] [--json] [--session-id <id>] "task"
//   <profile> defaults to headless and is configurable (issue #9) — see DEFAULT_DSH_PROFILE.
//   --patch is a LAUNCHER option, so it must precede the app's --json (see dshArgv); the overlay
//   carries a run's reasoning effort.
// Event schema VERIFIED 2026-10-07 (dsh 0.2.0-rc.2, phase0/dsh-e2e.txt):
//   {"type":"session","sessionId":...,"cwd":...}
//   {"type":"status","phase":"turn_start"|"step_start"|"step_end"|"turn_end",...}
//     step_end carries usage {inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,totalTokens}
//   {"type":"thinking","text":...}
//   {"type":"text","text":...}
//   {"type":"final","text":...}
//
// Reasoning effort (2026-10-07): headless exposes NO effort flag and no env var — `--help` lists
// only task/--json/--session-id. The only external channel is the profile tree, so an effort is
// injected as a `--patch` overlay pinning agent-default-model.config.reasoningEffort. Verified:
// the overlay reaches the composed config, and dsh fails startup loudly if it is malformed.
import { spawn, execFile } from 'node:child_process';
import { createInterface } from 'node:readline';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCredential } from '../config/secrets.ts';

export interface DshRunOutcome {
  sessionId?: string;
  text: string;
  exitCode: number | null;
  events: any[];
  usage: { input?: number; output?: number; cachedRead?: number };
  stderr: string;
  /** Reasoning effort the caller asked for, when any. */
  effortRequested?: string;
  /** True only when the overlay was written and passed as `--patch` (argv is the evidence). */
  effortApplied?: boolean;
  /** Why the effort was not applied — set whenever `effortRequested` is set and `effortApplied` is not. */
  effortError?: string;
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
 * without spawning anything (see tests/unit/dsh-profile.test.ts).
 *
 * Order is a CONTRACT, not a style choice. dsh is
 * `dsh [launcher options] <profile> [options] [app-args...]`: `--patch` is a *launcher* option,
 * while `--json` and `--session-id` belong to the headless app. Placing `--patch` after `--json`
 * makes the launcher stop recognising it and the run dies with
 * `{"type":"error","message":"unknown option '--patch'"}` — an error the `--json` stream reports
 * on STDOUT, so it surfaces as a single event with empty stderr and exit code 1 (verified
 * 2026-10-07). tests/unit/dsh-effort.test.ts pins that ordering.
 */
export function dshArgv(opts: { profile?: string; sessionId?: string; task?: string; overlayPath?: string } = {}): string[] {
  const profile = opts.profile ?? DEFAULT_DSH_PROFILE;
  assertProfileName(profile);
  const args = [dshBinPath(), '--profile', profile];
  if (opts.overlayPath) args.push('--patch', opts.overlayPath);
  args.push('--json');
  if (opts.sessionId) args.push('--session-id', opts.sessionId);
  if (opts.task !== undefined) args.push(opts.task);
  return args;
}

// ── Reasoning effort over the profile layer ────────────────────────────────────────────────
//
// The four levels dsh's DeepSeek adapter accepts (dsh-llm-deepseek's REASONING_EFFORTS:
// Off/Low/High/Max). Anything else would pass dsh's plugin schema and then fail at request
// time with UNSUPPORTED_REASONING_EFFORT, so we reject it here instead.
// tests/unit/dsh-effort.test.ts asserts this list still matches
// registry/capability-matrix.json → agents.dsh.capabilities.reasoning_effort.options.
export const DSH_REASONING_EFFORTS = ['off', 'low', 'high', 'max'] as const;

export interface DshProfileDefaultModel {
  provider: string;
  model: string;
}

/** YAML scalar: bare when unambiguous, JSON-quoted otherwise (JSON string is valid YAML). */
function yamlScalar(v: string): string {
  return /^[A-Za-z0-9._/@-]+$/.test(v) ? v : JSON.stringify(v);
}

/** The `agent-default-model` row of a `--dump-config` tree (empty string when absent). */
function extractRow(dump: string, id: string): string {
  const lines = dump.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `- id: ${id}`);
  if (start < 0) return '';
  const out: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^- /.test(lines[i])) break;   // next top-level row
    out.push(lines[i]);
  }
  return out.join('\n');
}

/**
 * Build the `--patch` overlay that pins one run's reasoning effort.
 *
 * A profile patch REPLACES the whole `config` object of the targeted row (documented in
 * ~/.dsh/cordis.patch.yml), so `provider`/`model` must be restated — an overlay carrying only
 * `reasoningEffort` makes dsh exit with "startup failed: $.provider missing required value".
 * That is why the base values are read from the live tree instead of hardcoded: this driver
 * must work on any machine, and dsh's own model ids do not match the registry's (`deepseek-flash`
 * vs `deepseek-v4-flash`).
 */
export function buildEffortOverlay(effort: string, base: DshProfileDefaultModel): string {
  return [
    '# Written by agent-control-plane for ONE dsh run; deleted when the run returns.',
    '# A profile patch replaces the whole config object, so provider/model are restated.',
    '- id: agent-default-model',
    '  config:',
    `    provider: ${yamlScalar(base.provider)}`,
    `    model: ${yamlScalar(base.model)}`,
    `    reasoningEffort: ${yamlScalar(effort)}`,
    '',
  ].join('\n');
}

const profileModelCache = new Map<string, DshProfileDefaultModel>();

/**
 * Read the composed `agent-default-model` row (provider + model) from the live profile tree.
 *
 * Cheap (~0.7s) and only ever called when an effort was actually requested, so the common path
 * pays nothing. Cached per profile for the process — the tree does not change mid-run. Returns
 * undefined rather than guessing: callers then report the effort as not applied instead of
 * silently pinning a wrong model.
 */
export async function readProfileDefaultModel(profile = DEFAULT_DSH_PROFILE): Promise<DshProfileDefaultModel | undefined> {
  const hit = profileModelCache.get(profile);
  if (hit) return hit;
  try {
    const dump = await new Promise<string>((resolve, reject) => {
      execFile(dshCommand(), [...dshArgs(), '--profile', profile, '--dump-config'],
        { windowsHide: true, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout) => (err ? reject(err) : resolve(stdout)));
    });
    const row = extractRow(dump, 'agent-default-model');
    // Tie the extraction to the row we think we found: a wrong block would silently reroute the
    // run to another model, which is worse than not applying the effort at all.
    if (!row.includes(`'@deepseek-ai/dsh-agent-default-model'`)) return undefined;
    const provider = /^[ \t]+provider:[ \t]*(\S+)[ \t]*$/m.exec(row)?.[1];
    const model = /^[ \t]+model:[ \t]*(\S+)[ \t]*$/m.exec(row)?.[1];
    if (!provider || !model || provider.includes('!!js') || model.includes('!!js')) return undefined;
    const found = { provider, model };
    profileModelCache.set(profile, found);
    return found;
  } catch {
    return undefined;   // unreadable tree -> report not-applied, never fail the task
  }
}

export interface EffortOverlayPlan {
  /** Overlay body to write, when the effort can be applied. */
  yaml?: string;
  /** Why it cannot — every rejection names its cause instead of silently doing nothing. */
  error?: string;
}

/**
 * Decide how to apply one run's reasoning effort, without touching the filesystem.
 *
 * Split out from `run()` so the decision is unit-testable with an injected profile reader:
 * the interesting cases (unknown level, unreadable profile) must be provable without spawning
 * a real dsh or reaching the network.
 */
export async function planEffortOverlay(
  effort: string | undefined,
  opts: { profile?: string; readBase?: () => Promise<DshProfileDefaultModel | undefined> } = {},
): Promise<EffortOverlayPlan> {
  const wanted = effort?.trim();
  if (!wanted) return {};
  if (!(DSH_REASONING_EFFORTS as readonly string[]).includes(wanted)) {
    return { error: `dsh does not accept reasoning effort "${wanted}" (supported: ${DSH_REASONING_EFFORTS.join(' | ')})` };
  }
  const profile = opts.profile ?? DEFAULT_DSH_PROFILE;
  const base = await (opts.readBase ?? (() => readProfileDefaultModel(profile)))();
  if (!base) {
    return { error: 'could not read agent-default-model (provider/model) from `dsh --dump-config`; the overlay must restate them' };
  }
  return { yaml: buildEffortOverlay(wanted, base) };
}

export class DshDriver {
  // One-shot run (headless is stateless apart from --session-id adoption).
  static async run(
    task: string,
    opts: {
      cwd: string; sessionId?: string; timeoutMs?: number; profile?: string; effort?: string;
      onEvent?: (e: { kind: 'text' | 'tool' | 'status'; text?: string }) => void;
    },
  ): Promise<DshRunOutcome> {
    // Resolve the effort overlay BEFORE spawning: it changes argv (--patch), and every failure
    // mode here is reported rather than guessed at.
    const effortRequested = opts.effort?.trim() || undefined;
    let overlayPath: string | undefined;
    let effortApplied = false;
    let effortError: string | undefined;

    if (effortRequested) {
      const plan = await planEffortOverlay(effortRequested, { profile: opts.profile });
      if (plan.error) {
        effortError = plan.error;
      } else if (plan.yaml) {
        try {
          overlayPath = join(tmpdir(), `acp-dsh-effort-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.yml`);
          writeFileSync(overlayPath, plan.yaml, 'utf8');
          effortApplied = true;
        } catch (e: any) {
          overlayPath = undefined;
          effortError = `could not write the effort overlay: ${String(e?.message ?? e).slice(0, 200)}`;
        }
      }
    }

    // issue #9: no hard-coded profile — see dshArgv(). An unknown profile is passed through and
    // dsh's own failure is surfaced verbatim (never a silent fallback to headless).
    const args = dshArgv({ profile: opts.profile, sessionId: opts.sessionId, task, overlayPath });

    const annotate = <T extends DshRunOutcome>(o: T): T => ({ ...o, effortRequested, effortApplied, effortError });

    return new Promise((resolve) => {
      const cleanupOverlay = () => {
        if (overlayPath) { try { rmSync(overlayPath, { force: true }); } catch { /* noop */ } }
      };
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
        cleanupOverlay();
        resolve(annotate({ sessionId, text: '', exitCode: null, events, usage, stderr: stderr + String(e) }));
      });
      child.on('exit', (code) => {
        clearTimeout(timer);
        cleanupOverlay();
        resolve(annotate({
          sessionId,
          text: (finalText || streamText).trim(),
          exitCode: code,
          events,
          usage,
          stderr: stderr.slice(-4000),
        }));
      });
    });
  }
}

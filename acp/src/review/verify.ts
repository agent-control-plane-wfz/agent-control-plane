// Neutral verification (Phase 4): done is decided by OBJECTIVE signals only —
// commands that must exit 0. No LLM may declare success.
import { execFile } from 'node:child_process';

export interface VerifyCommand {
  cmd: string;            // executable, e.g. 'node'
  args?: string[];        // argv array (no shell escaping involved)
}

export interface VerifyItemResult {
  cmd: string;
  args: string[];
  passed: boolean;
  exitCode: number | null;
  signal?: string;
  stdoutTail: string;
  stderrTail: string;
  durationMs: number;
}

export interface VerifyResult {
  allPassed: boolean;
  results: VerifyItemResult[];
}

function runOne(vc: VerifyCommand, cwd: string, timeoutMs: number): Promise<VerifyItemResult> {
  const t0 = Date.now();
  return new Promise((resolve) => {
    execFile(vc.cmd, vc.args ?? [], { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        // non-zero exit => err; timeout kills => err.signal === 'SIGTERM'
        const exitCode = (err as any)?.code ?? (err ? null : 0);
        const numeric = typeof exitCode === 'number' ? exitCode : (err ? -1 : 0);
        resolve({
          cmd: vc.cmd,
          args: vc.args ?? [],
          passed: numeric === 0,
          exitCode: numeric,
          signal: (err as any)?.signal,
          stdoutTail: String(stdout ?? '').slice(-1500),
          stderrTail: String(stderr ?? '').slice(-1500),
          durationMs: Date.now() - t0,
        });
      });
  });
}

export async function runVerification(cmds: VerifyCommand[], cwd: string, timeoutMs = 180_000): Promise<VerifyResult> {
  const results: VerifyItemResult[] = [];
  for (const vc of cmds) {
    const r = await runOne(vc, cwd, timeoutMs);
    results.push(r);
    if (!r.passed) break; // fail fast
  }
  return { allPassed: results.every((r) => r.passed) && results.length === cmds.length, results };
}

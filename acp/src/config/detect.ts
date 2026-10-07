// "detected" (issue #7): can this machine even run the agent? The command resolves and any
// entry-file arguments exist.
//
// This is deliberately a SEPARATE state from the other two:
//   detected   — a machine fact (an adapter package is installed / a CLI is on PATH)
//   configured — the user's answer ("yes, use this one"); the only state that is routable
//   reachable  — a handshake succeeded (the process starts; says nothing about credentials)
// Installing a dependency must never be mistaken for consent to spawn processes, spend quota,
// and run commands in the user's repository — which is exactly what the old default did.
import { existsSync } from 'node:fs';
import { resolveCli } from '../core/resolve-cli.ts';

export interface Detection {
  detected: boolean;
  /** Human-readable reason, shown in the wizard so a half-installed workspace is obvious. */
  detail: string;
}

export function detectAgent(cfg: { command?: string; args?: string[] } | undefined): Detection {
  if (!cfg?.command) return { detected: false, detail: '未配置命令' };
  try {
    resolveCli(cfg.command);
  } catch (e: any) {
    return { detected: false, detail: `命令不可解析：${String(e?.message ?? e).slice(0, 120)}` };
  }
  // Path-like arguments are the adapter entry points; a missing one fails at spawn time, which
  // is the failure a fresh clone gets when the packages are not installed.
  const fileArgs = (cfg.args ?? []).filter((a) => /[\\/]/.test(a) || /\.(js|mjs|cjs)$/.test(a));
  const missing = fileArgs.filter((a) => !existsSync(a));
  if (missing.length) return { detected: false, detail: `入口不存在：${missing[0]}` };
  return { detected: true, detail: '命令与入口均存在' };
}

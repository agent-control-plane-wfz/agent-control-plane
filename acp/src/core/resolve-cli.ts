// Resolve a configured CLI command into something spawn() can actually execute.
//
// Why this exists: on Windows `spawn('opencode')` fails with ENOENT even though `opencode`
// is on PATH. npm installs a shell shim — an extensionless shell script plus `.cmd` and
// `.ps1` — and Windows/CreateProcess only auto-appends `.exe`. Spawning the `.cmd` directly
// is rejected too (EINVAL); it has to go through the command interpreter. Measured here on
// 2026-10-07 with opencode v2.0.22:
//
//   spawn('opencode')                            -> ENOENT
//   spawn('<npm-global>\\opencode.cmd')            -> EINVAL
//   spawn('<npm-global>\\opencode')  (no ext)     -> ENOENT
//   spawn(ComSpec, ['/c', '<npm-global>\\opencode.cmd']) -> OK  "opencode v2.0.22"
//   spawn('<npm-global>\\node_modules\\...\\opencode.exe') -> OK  "opencode v2.0.22"
//
// So bare names are resolved against PATH (preferring a real `.exe`) and `.cmd`/`.bat` are
// wrapped in the interpreter. Doing this at spawn time lets the configured default stay
// portable (`opencode`) instead of baking one machine's absolute path into the config.
import { existsSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';

export interface ResolvedCli {
  command: string;        // what to pass as spawn()'s argv0
  prefixArgs: string[];   // argv prepended before the configured args
  resolvedFrom: string;   // the file we found (for diagnostics)
}

const isWin = process.platform === 'win32';
// Preference order matters: a real .exe beats a shell shim.
const WIN_EXTS = ['.exe', '.cmd', '.bat', '.com'];
const cache = new Map<string, ResolvedCli>();

function isFile(p: string): boolean {
  try { return existsSync(p) && statSync(p).isFile(); } catch { return false; }
}

function wrap(program: string, env: NodeJS.ProcessEnv): ResolvedCli {
  if (isWin && /\.(cmd|bat)$/i.test(program)) {
    // Must go through the interpreter, else spawn throws EINVAL.
    const quoted = /\s/.test(program) ? `"${program}"` : program;
    return { command: env.ComSpec || 'cmd.exe', prefixArgs: ['/c', quoted], resolvedFrom: program };
  }
  return { command: program, prefixArgs: [], resolvedFrom: program };
}

function searchPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const dirs = (env.PATH ?? env.Path ?? '').split(delimiter).filter(Boolean);
  // If the name already carries a Windows extension (opencode.cmd), do NOT append another
  // one — that would look for "opencode.cmd.exe" and never match.
  const hasExt = isWin && WIN_EXTS.some((e) => name.toLowerCase().endsWith(e));
  const exts = !isWin ? [''] : hasExt ? [''] : WIN_EXTS;
  for (const dir of dirs) {
    for (const ext of exts) {
      const p = join(dir, name + ext);
      if (isFile(p)) return p;
    }
  }
  return undefined;
}

export function resolveCli(name: string, env: NodeJS.ProcessEnv = process.env): ResolvedCli {
  const key = `${name}\u0000${env.PATH ?? ''}\u0000${env.ComSpec ?? ''}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const out = resolveUncached(name, env);
  cache.set(key, out);
  return out;
}

function resolveUncached(name: string, env: NodeJS.ProcessEnv): ResolvedCli {
  const looksLikePath = name.includes('/') || name.includes('\\') || isAbsolute(name);
  if (looksLikePath) {
    if (isFile(name)) return wrap(name, env);
    throw new Error(
      `command "${name}" does not exist. Fix it in Settings → Agents, or set an explicit `
      + 'path to the executable.',
    );
  }
  const found = searchPath(name, env);
  if (found) return wrap(found, env);
  throw new Error(
    `command "${name}" was not found on PATH (checked ${isWin ? WIN_EXTS.join('/') : 'the bare name'}). `
    + 'Install it, or set an explicit path in Settings → Agents (or the matching *_BIN variable).',
  );
}

/** Test seam: forget memoised lookups (used by unit tests that mock PATH). */
export function clearResolveCliCache(): void {
  cache.clear();
}

// Workspace manager (Phase 3): 'shared' cwd or isolated per-agent git worktree.
// Worktree isolation = git branch isolation ONLY (not a sandbox) — plan v2.1 risk note.
import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

function git(repoDir: string, args: string[], timeoutMs = 60_000): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', repoDir, ...args], { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`git ${args.join(' ')} failed: ${String(err.message).slice(0, 300)} | stderr: ${String(stderr).slice(0, 300)}`));
        else resolve({ stdout, stderr });
      });
  });
}

export interface PreparedWorkspace {
  kind: 'shared' | 'worktree';
  path: string;
  branch?: string;
  cleanup: () => Promise<void>;
}

export interface WorkspaceOptions {
  repoDir: string;
  agent: string;
  mode: 'shared' | 'worktree';
  baseDir?: string;   // where worktrees are created (default: <repo>/../.acp-worktrees)
  keep?: boolean;     // keep worktree after use (default: remove, keep branch)
}

export async function prepareWorkspace(opts: WorkspaceOptions): Promise<PreparedWorkspace> {
  if (opts.mode === 'shared') {
    return { kind: 'shared', path: opts.repoDir, cleanup: async () => {} };
  }
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const branch = `acp/${opts.agent}/${ts}`;
  const base = opts.baseDir ?? join(dirname(opts.repoDir), '.acp-worktrees');
  const dest = join(base, `${basename(opts.repoDir)}-${opts.agent}-${ts}`);
  await mkdir(base, { recursive: true });
  await git(opts.repoDir, ['worktree', 'add', dest, '-b', branch]);
  return {
    kind: 'worktree',
    path: dest,
    branch,
    cleanup: async () => {
      if (opts.keep) return;
      try {
        await git(opts.repoDir, ['worktree', 'remove', '--force', dest]);
      } catch {
        await git(opts.repoDir, ['worktree', 'prune']).catch(() => {});
      }
    },
  };
}

// Mechanism self-test without any LLM: init a scratch repo, add worktree, verify, cleanup.
export async function selfTest(): Promise<{ ok: boolean; detail: string }> {
  const here = dirname(fileURLToPath(import.meta.url));
  const repo = join(here, '..', '..', 'tests', '.wt-scratch-repo');
  const fs = await import('node:fs');
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* shim may block; tolerate */ }
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(join(repo, 'a.txt'), 'v1');
  const run = (args: string[]) => new Promise<void>((res, rej) =>
    execFile('git', args, { windowsHide: true }, (e) => (e ? rej(new Error(String(e))) : res())));
  await run(['init', '-q', repo]);
  await run(['-C', repo, 'add', '.']);
  await run(['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init']);
  const ws = await prepareWorkspace({ repoDir: repo, agent: 'probe', mode: 'worktree' });
  const okDir = fs.existsSync(join(ws.path, 'a.txt'));
  const br = (await git(ws.path, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim();
  await ws.cleanup();
  const gone = !fs.existsSync(ws.path);
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* tolerate */ }
  const ok = okDir && br.startsWith('acp/probe/') && gone;
  return { ok, detail: `worktreeCreated=${okDir} branch=${br} cleanedUp=${gone}` };
}

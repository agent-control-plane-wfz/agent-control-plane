// Regression tests for issue #2 — F5: worktree cleanup dropped the checkout but leaked the
// acp/<agent>/<ts> branch on every run. Runs the real git mechanism on a scratch repo.
//
// Windows note: git in a temp dir can transiently fail with EBUSY/EPERM while another
// process (indexer, antivirus, a parallel test file) still holds a handle — the class of
// failure a contributor saw as a bare "spawnSync git EBUSY". Those codes are retried
// briefly, and a final failure carries the command plus the repo path so it is actionable.
// ACP_TEST_TMP can move the scratch repos to another volume.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { prepareWorkspace } from '../../src/workspace/manager.ts';

const scratchRoot = process.env.ACP_TEST_TMP ?? tmpdir();
const mkScratch = (prefix: string) => mkdtempSync(join(scratchRoot, prefix));

const sleepSync = (ms: number) => {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* ignore */ }
};

/** Run git, retrying the transient Windows codes, with an actionable failure message. */
function gitRun(args: string[], cwd: string, attempts = 4): string {
  let last: any;
  for (let i = 0; i < attempts; i++) {
    try {
      return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' });
    } catch (e: any) {
      last = e;
      const transient = /EBUSY|EPERM|EACCES|ETXTBSY/.test(String(e?.code ?? '') + String(e?.message ?? ''));
      if (!transient) break;
      sleepSync(150 * (i + 1));
    }
  }
  const detail = String(last?.stderr ?? last?.message ?? last).slice(0, 200);
  throw new Error(
    `git ${args.join(' ')} failed in ${cwd} (${last?.code ?? 'unknown'}): ${detail}`
    + (process.env.ACP_TEST_TMP ? '' : ' — if this is EBUSY/EPERM, try setting ACP_TEST_TMP to another drive.'),
  );
}

function scratchRepo(): string {
  const repo = mkScratch('acp-wt-');
  gitRun(['init', '-q'], repo);
  writeFileSync(join(repo, 'a.txt'), 'v1');
  gitRun(['add', '.'], repo);
  gitRun(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], repo);
  return repo;
}

test('F5: cleanup removes the worktree AND reclaims the branch', async () => {
  const repo = scratchRepo();
  const base = mkScratch('acp-wtbase-');

  const ws = await prepareWorkspace({ repoDir: repo, agent: 'probe', mode: 'worktree', baseDir: base });
  assert.equal(ws.kind, 'worktree');
  assert.match(ws.branch ?? '', /^acp\/probe\//);

  await ws.cleanup();

  const branches = gitRun(['branch', '--list', 'acp/probe/*'], repo).trim();
  assert.equal(branches, '', `no acp/probe/* branch may survive cleanup, got: ${branches}`);
});

test('F5: three create/cleanup cycles leak nothing', async () => {
  const repo = scratchRepo();
  const base = mkScratch('acp-wtbase3-');
  for (let i = 0; i < 3; i++) {
    const ws = await prepareWorkspace({ repoDir: repo, agent: 'dsh', mode: 'worktree', baseDir: base });
    await ws.cleanup();
  }
  const branches = gitRun(['branch', '--list', 'acp/dsh/*'], repo).trim();
  assert.equal(branches, '', `expected no leaked branches, got: ${branches}`);
});

test('keep:true leaves the worktree and branch in place', async () => {
  const repo = scratchRepo();
  const base = mkScratch('acp-wtkeep-');
  const ws = await prepareWorkspace({ repoDir: repo, agent: 'probe', mode: 'worktree', baseDir: base, keep: true });
  await ws.cleanup();
  const branches = gitRun(['branch', '--list', 'acp/probe/*'], repo).trim();
  assert.notEqual(branches, '', 'keep:true must preserve the branch');
});

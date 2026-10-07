// Regression tests for issue #2 — F5: worktree cleanup dropped the checkout but leaked the
// acp/<agent>/<ts> branch on every run. Runs the real git mechanism on a scratch repo.
//
// Spawning note (issue #5): these helpers use the ASYNC child_process API on purpose.
// A contributor's Windows environment fails every *synchronous* spawn (spawnSync/execFileSync
// of git, node and cmd all return EBUSY) while async spawn works fine — and the product only
// ever spawns asynchronously, so a sync-based test both broke there and tested a path the
// product does not use. Async keeps the tests portable and exercises the real spawn path.
//
// Scratch repos live under ACP_TEST_TMP if set, else the OS temp dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { prepareWorkspace } from '../../src/workspace/manager.ts';

const scratchRoot = process.env.ACP_TEST_TMP ?? tmpdir();
const mkScratch = (prefix: string) => mkdtempSync(join(scratchRoot, prefix));

/** Run git asynchronously, with an actionable failure message. */
function gitRun(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { encoding: 'utf8' }, (err, stdout) => {
      if (err) {
        const e = err as NodeJS.ErrnoException & { stderr?: string };
        reject(new Error(
          `git ${args.join(' ')} failed in ${cwd} (${e.code ?? 'unknown'}): `
          + String(e.stderr ?? e.message).slice(0, 200),
        ));
        return;
      }
      resolve(String(stdout));
    });
  });
}

async function scratchRepo(): Promise<string> {
  const repo = mkScratch('acp-wt-');
  await gitRun(['init', '-q'], repo);
  writeFileSync(join(repo, 'a.txt'), 'v1');
  await gitRun(['add', '.'], repo);
  await gitRun(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init'], repo);
  return repo;
}

test('F5: cleanup removes the worktree AND reclaims the branch', async () => {
  const repo = await scratchRepo();
  const base = mkScratch('acp-wtbase-');

  const ws = await prepareWorkspace({ repoDir: repo, agent: 'probe', mode: 'worktree', baseDir: base });
  assert.equal(ws.kind, 'worktree');
  assert.match(ws.branch ?? '', /^acp\/probe\//);

  await ws.cleanup();

  const branches = (await gitRun(['branch', '--list', 'acp/probe/*'], repo)).trim();
  assert.equal(branches, '', `no acp/probe/* branch may survive cleanup, got: ${branches}`);
});

test('F5: three create/cleanup cycles leak nothing', async () => {
  const repo = await scratchRepo();
  const base = mkScratch('acp-wtbase3-');
  for (let i = 0; i < 3; i++) {
    const ws = await prepareWorkspace({ repoDir: repo, agent: 'dsh', mode: 'worktree', baseDir: base });
    await ws.cleanup();
  }
  const branches = (await gitRun(['branch', '--list', 'acp/dsh/*'], repo)).trim();
  assert.equal(branches, '', `expected no leaked branches, got: ${branches}`);
});

test('keep:true leaves the worktree and branch in place', async () => {
  const repo = await scratchRepo();
  const base = mkScratch('acp-wtkeep-');
  const ws = await prepareWorkspace({ repoDir: repo, agent: 'probe', mode: 'worktree', baseDir: base, keep: true });
  await ws.cleanup();
  const branches = (await gitRun(['branch', '--list', 'acp/probe/*'], repo)).trim();
  assert.notEqual(branches, '', 'keep:true must preserve the branch');
});

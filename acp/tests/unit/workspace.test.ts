// Regression tests for issue #2 — F5: worktree cleanup dropped the checkout but leaked the
// acp/<agent>/<ts> branch on every run. Runs the real git mechanism on a scratch repo.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { prepareWorkspace } from '../../src/workspace/manager.ts';

function scratchRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'acp-wt-'));
  const git = (args: string[], cwd = repo) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'pipe' });
  git(['init', '-q']);
  writeFileSync(join(repo, 'a.txt'), 'v1');
  git(['add', '.']);
  git(['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init']);
  return repo;
}

test('F5: cleanup removes the worktree AND reclaims the branch', async () => {
  const repo = scratchRepo();
  const base = mkdtempSync(join(tmpdir(), 'acp-wtbase-'));
  mkdirSync(base, { recursive: true });

  const ws = await prepareWorkspace({ repoDir: repo, agent: 'probe', mode: 'worktree', baseDir: base });
  assert.equal(ws.kind, 'worktree');
  assert.match(ws.branch ?? '', /^acp\/probe\//);

  await ws.cleanup();

  const branches = execFileSync('git', ['-C', repo, 'branch', '--list', 'acp/probe/*'], { encoding: 'utf8' }).trim();
  assert.equal(branches, '', `no acp/probe/* branch may survive cleanup, got: ${branches}`);
});

test('F5: three create/cleanup cycles leak nothing', async () => {
  const repo = scratchRepo();
  const base = mkdtempSync(join(tmpdir(), 'acp-wtbase3-'));
  for (let i = 0; i < 3; i++) {
    const ws = await prepareWorkspace({ repoDir: repo, agent: 'dsh', mode: 'worktree', baseDir: base });
    await ws.cleanup();
  }
  const branches = execFileSync('git', ['-C', repo, 'branch', '--list', 'acp/dsh/*'], { encoding: 'utf8' }).trim();
  assert.equal(branches, '', `expected no leaked branches, got: ${branches}`);
});

test('keep:true leaves the worktree and branch in place', async () => {
  const repo = scratchRepo();
  const base = mkdtempSync(join(tmpdir(), 'acp-wtkeep-'));
  const ws = await prepareWorkspace({ repoDir: repo, agent: 'probe', mode: 'worktree', baseDir: base, keep: true });
  await ws.cleanup();
  const branches = execFileSync('git', ['-C', repo, 'branch', '--list', 'acp/probe/*'], { encoding: 'utf8' }).trim();
  assert.notEqual(branches, '', 'keep:true must preserve the branch');
});

// Unit tests for the CLI resolver — the piece that makes a portable default like
// `opencode` actually spawnable on Windows (npm ships a .cmd shim; spawn rejects it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { resolveCli, clearResolveCliCache } from '../../src/core/resolve-cli.ts';

const isWin = process.platform === 'win32';

/** Build a fake PATH with the given file names present. */
function fakePath(files: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'acp-resolve-'));
  for (const f of files) {
    const p = join(dir, f);
    writeFileSync(p, '#!/bin/sh\nexit 0\n');
    if (!isWin) chmodSync(p, 0o755);
  }
  const env = { ...process.env, PATH: dir, Path: dir };
  clearResolveCliCache();
  return { dir, env };
}

test('resolveCli: an absolute existing file is used as-is', () => {
  const { dir, env } = fakePath(['tool.bin']);
  const r = resolveCli(join(dir, 'tool.bin'), env);
  assert.equal(r.command, join(dir, 'tool.bin'));
  assert.deepEqual(r.prefixArgs, []);
});

test('resolveCli: a missing absolute path fails loudly with a fix hint', () => {
  const { dir, env } = fakePath([]);
  assert.throws(() => resolveCli(join(dir, 'nope.exe'), env), /does not exist/);
});

test('resolveCli: a name not on PATH fails loudly instead of ENOENT deep in spawn', () => {
  const { env } = fakePath([]);
  assert.throws(() => resolveCli('definitely-not-a-real-cli-xyz', env), /not found on PATH/);
});

if (isWin) {
  test('resolveCli: a .cmd shim is wrapped in the interpreter (spawn rejects it raw)', () => {
    const { dir, env } = fakePath(['shim.cmd']);
    const r = resolveCli('shim', env);
    assert.match(r.command, /cmd\.exe$/i, 'must go through the command interpreter');
    assert.deepEqual(r.prefixArgs, ['/c', join(dir, 'shim.cmd')]);
  });

  test('resolveCli: a real .exe is preferred over a .cmd of the same name', () => {
    const { dir, env } = fakePath(['both.exe', 'both.cmd']);
    const r = resolveCli('both', env);
    assert.equal(r.command, join(dir, 'both.exe'));
    assert.deepEqual(r.prefixArgs, []);
  });

  test('resolveCli: a name that already has an extension is not double-suffixed', () => {
    const { dir, env } = fakePath(['thing.exe']);
    const r = resolveCli('thing.exe', env);
    assert.equal(r.command, join(dir, 'thing.exe'));
  });
} else {
  test('resolveCli: a plain executable name resolves on POSIX', () => {
    const { dir, env } = fakePath(['tool']);
    const r = resolveCli('tool', env);
    assert.equal(r.command, join(dir, 'tool'));
    assert.deepEqual(r.prefixArgs, []);
  });
}

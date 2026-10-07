// Unit tests: dsh reasoning effort — declaration, fallback and the --patch overlay plan.
//
// Why this file exists: dsh runs as a `json-process` transport with no ACP handshake, so
// `configOptions_observed` can never carry an effort list for it, and the console rendered
// "0 档" for an agent that in fact accepts four levels. The fix reads a DECLARED capability
// instead of fabricating an observation; these tests pin that distinction plus the two traps
// found while building the overlay (a profile patch replaces the whole config object, and
// `--patch` must precede the app's own `--json`).
//
// Run: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Registry } from '../../src/registry/registry.ts';
import {
  DSH_REASONING_EFFORTS, buildEffortOverlay, dshArgv, planEffortOverlay,
} from '../../src/drivers/dsh-driver.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'acp-dsh-effort-'));

function fixture(matrixAgents: Record<string, any>): Registry {
  const d = mkdtempSync(join(root, 'case-'));
  const write = (name: string, v: any) => {
    const p = join(d, name);
    writeFileSync(p, JSON.stringify(v), 'utf8');
    return p;
  };
  return new Registry(
    write('matrix.json', { agents: matrixAgents }),
    write('models.json', { models: {}, agentDefaults: {} }),
    write('observed.json', { agents: {} }),
    join(d, 'no-such-file.json'),
  );
}

test('the declared level list matches what the adapter actually accepts (drift guard)', () => {
  // dsh-llm-deepseek's REASONING_EFFORTS is the real source of truth. If the adapter gains or
  // renames a level, this fails here rather than at request time with UNSUPPORTED_REASONING_EFFORT.
  const matrix = JSON.parse(readFileSync(join(here, '..', '..', '..', 'registry', 'capability-matrix.json'), 'utf8'));
  assert.deepEqual(
    matrix.agents.dsh.capabilities.reasoning_effort.options,
    [...DSH_REASONING_EFFORTS],
    'the matrix declaration and the driver constant must not drift apart',
  );
  assert.equal(matrix.agents.dsh.capabilities.reasoning_effort.supported, true);
});

test('effortOptions: a json-process agent reports its DECLARED levels, not an empty list', () => {
  const reg = fixture({
    dsh: {
      transport: 'json-process',
      capabilities: { reasoning_effort: { supported: true, options: ['off', 'low', 'high', 'max'] } },
    },
  });
  // No configOptions_observed is possible for this transport; the declared block is the answer.
  assert.deepEqual(reg.effortOptions('dsh'), ['off', 'low', 'high', 'max']);
});

test('effortOptions: a real observation still outranks the declaration', () => {
  const reg = fixture({
    probed: {
      transport: 'acp',
      capabilities: { reasoning_effort: { supported: true, options: ['declared-only'] } },
      configOptions_observed: { effort: { options: ['observed-a', 'observed-b'] } },
    },
  });
  assert.deepEqual(reg.effortOptions('probed'), ['observed-a', 'observed-b']);
});

test('effortOptions: no declaration and no observation is an empty list, never a guess', () => {
  const reg = fixture({ bare: { transport: 'acp' } });
  assert.deepEqual(reg.effortOptions('bare'), []);
});

test('supportsConfig mirrors the same two sources', () => {
  const reg = fixture({
    declared: { transport: 'json-process', capabilities: { reasoning_effort: { supported: true, options: ['off'] } } },
    bare: { transport: 'acp' },
  });
  assert.equal(reg.supportsConfig('declared', 'effort'), true, 'a declared capability counts');
  assert.equal(reg.supportsConfig('bare', 'effort'), false);
  assert.equal(reg.supportsConfig('declared', 'model'), false, 'dsh still has no model channel');
});

test('planEffortOverlay: no effort requested plans nothing at all', async () => {
  for (const v of [undefined, '', '   ']) {
    assert.deepEqual(await planEffortOverlay(v), {});
  }
});

test('planEffortOverlay: an unsupported level is rejected by name, before any spawn', async () => {
  let readerCalled = false;
  const plan = await planEffortOverlay('ultra', {
    readBase: async () => {
      readerCalled = true;
      return { provider: 'deepseek-official', model: 'deepseek-flash' };
    },
  });
  assert.match(String(plan.error), /ultra/, 'the message names the rejected value');
  assert.match(String(plan.error), /off \| low \| high \| max/, 'and lists what is accepted');
  assert.equal(plan.yaml, undefined);
  assert.equal(readerCalled, false, 'an invalid level never reaches the profile read');
});

test('planEffortOverlay: an unreadable profile is reported, not silently ignored', async () => {
  const plan = await planEffortOverlay('max', { readBase: async () => undefined });
  assert.match(String(plan.error), /dump-config/);
  assert.equal(plan.yaml, undefined);
});

test('planEffortOverlay: a supported level yields an overlay that RESTATES provider + model', async () => {
  const plan = await planEffortOverlay('max', {
    readBase: async () => ({ provider: 'deepseek-official', model: 'deepseek-flash' }),
  });
  assert.equal(plan.error, undefined);
  const yaml = String(plan.yaml);
  assert.match(yaml, /^- id: agent-default-model$/m);
  assert.match(yaml, /^ {4}provider: deepseek-official$/m);
  assert.match(yaml, /^ {4}model: deepseek-flash$/m, 'provider/model must be restated or dsh fails startup');
  assert.match(yaml, /^ {4}reasoningEffort: max$/m);
});

test('buildEffortOverlay quotes values YAML would otherwise reinterpret', () => {
  const yaml = buildEffortOverlay('low', { provider: 'x: y', model: 'plain' });
  assert.match(yaml, /provider: "x: y"/, 'a value containing ": " must be quoted');
  assert.match(yaml, /^ {4}model: plain$/m);
});

// DSH_BIN is only read by dshBinPath(); pinning it keeps the argv tests free of any real install.
function withBin<T>(fn: () => T): T {
  const prev = process.env.DSH_BIN;
  process.env.DSH_BIN = join(root, 'dsh-bin.js');
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.DSH_BIN; else process.env.DSH_BIN = prev;
  }
}

test('dshArgv puts --patch BEFORE the app args — launcher options come first (issue #9 + effort)', () => {
  // Regression: emitting `--profile headless --json --patch X` made dsh answer
  // {"type":"error","message":"unknown option '--patch'"} on stdout with exit 1 and empty stderr,
  // so the run looked like an ordinary failure. --patch is a launcher option and must precede
  // the app's --json — while still following the configurable --profile from issue #9.
  const args = withBin(() => dshArgv({ profile: 'headless', overlayPath: '/tmp/ov.yml', sessionId: 'session-1', task: 'do it' }));
  const iPatch = args.indexOf('--patch');
  const iJson = args.indexOf('--json');
  assert.ok(iPatch > 0, '--patch must be present');
  assert.ok(iPatch < iJson, "--patch is a LAUNCHER option and must come before the app's --json");
  assert.equal(args[iPatch + 1], '/tmp/ov.yml', '--patch takes the overlay path');
  assert.deepEqual(args.slice(args.indexOf('--profile'), args.indexOf('--profile') + 2), ['--profile', 'headless']);
  assert.equal(args[args.length - 1], 'do it', 'the task stays last');
});

test('dshArgv omits --patch entirely when no overlay was planned', () => {
  const args = withBin(() => dshArgv({ task: 't' }));
  assert.ok(!args.includes('--patch'), 'no effort requested means no profile patch at all');
  assert.deepEqual(args.slice(-2), ['--json', 't']);
});

test('dshArgv still honours a configured profile when an overlay is present', () => {
  const args = withBin(() => dshArgv({ profile: 'my-profile', overlayPath: '/tmp/ov.yml', task: 't' }));
  assert.deepEqual(args.slice(args.indexOf('--profile'), args.indexOf('--profile') + 2), ['--profile', 'my-profile']);
  assert.ok(args.indexOf('--patch') < args.indexOf('--json'), 'the ordering holds for any profile');
});

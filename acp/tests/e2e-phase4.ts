// E2E: Phase 4 — real closed loop on a scratch git repo.
// deepseek(via claude adapter) implements in an isolated worktree,
// codex (openai vendor) cross-reviews, node commands verify neutrally.
// Run: node --experimental-strip-types tests/e2e-phase4.ts
import './_isolate-state.ts';   // isolate state dir before app modules load
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ControlPlane } from '../src/control/plane.ts';

const here = dirname(fileURLToPath(import.meta.url));
// IMPORTANT: keep the scratch repo OUTSIDE the acp project tree — Node walks up to the
// nearest package.json and acp's "type":"module" would break the CommonJS calc.js.
// Path is machine-agnostic (PR #1 follow-up): override with ACP_TEST_TMP if needed.
const tmpRoot = process.env.ACP_TEST_TMP ?? join(tmpdir(), 'acp-p4-tmp');
const repo = join(tmpRoot, 'repo');
const plane = new ControlPlane();
let failed = false;

// 1) scratch repo
rmSync(tmpRoot, { recursive: true, force: true });
mkdirSync(repo, { recursive: true });
writeFileSync(join(repo, 'README.md'), 'scratch\n');
const run = (args: string[]) => new Promise<void>((res, rej) =>
  execFile('git', args, { windowsHide: true, cwd: repo }, (e, so, se) => (e ? rej(new Error(String(se || e))) : res())));
await run(['init', '-q', repo]);
await run(['-C', repo, 'add', '.']);
await run(['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init']);
console.log('scratch repo ready:', repo, '\n');

// 2) full loop
const outcome = await plane.heteroReview({
  task: [
    'Create a file named calc.js in the current working directory. CommonJS module.',
    'It must export a function add(a, b) such that:',
    '  - add(2, 3) returns 5',
    '  - calling add with any non-number argument throws TypeError',
    'Example: module.exports = { add };',
  ].join('\n'),
  cwd: repo,
  implementer: 'claude',          // actual vendor on this machine: deepseek
  implementerMode: 'acceptEdits', // auto-accept edits so the agent can write the file
  workspaceMode: 'worktree',      // isolated worktree for the implementer
  reviewerEffort: 'medium',       // codex (openai vendor) — true heterogeneity
  verifyCommands: [
    { cmd: 'node', args: ['-e', "const {add}=require('./calc.js'); if(add(2,3)!==5) process.exit(1); try { add('a',1); process.exit(1); } catch (e) { if (!(e instanceof TypeError)) process.exit(1); }"] },
  ],
  arbitrateOnConflict: true,
  timeoutMs: 240_000,
});

console.log('== implementation ==');
console.log(JSON.stringify({
  ok: outcome.implementation.ok, agent: outcome.implementation.agent,
  vendor: outcome.implementerVendor, sessionId: outcome.implementation.sessionId,
  workspace: outcome.implementation.workspace,
  textHead: outcome.implementation.text.slice(0, 150), error: outcome.implementation.error,
}, null, 2));

console.log('\n== review ==');
console.log(JSON.stringify({
  agent: outcome.review?.agent, vendor: outcome.reviewerVendor,
  verdict: outcome.review?.verdict, verdictError: outcome.review?.verdictError,
  error: outcome.review?.error,
}, null, 2));

console.log('\n== neutral verification ==');
console.log(JSON.stringify(outcome.verification, null, 2));

if (outcome.arbitration) {
  console.log('\n== arbitration ==');
  console.log(JSON.stringify({ agent: outcome.arbitration.agent, verdict: outcome.arbitration.verdict }, null, 2));
}

console.log('\n== consensus ==');
console.log(outcome.consensus, '—', outcome.detail);

if (!outcome.implementation.ok) failed = true;
if (!outcome.review?.verdict) failed = true;
if (outcome.reviewerVendor === outcome.implementerVendor) failed = true;
if (!outcome.verification?.allPassed) failed = true;
if (!['verified', 'review_disputed'].includes(outcome.consensus)) failed = true;

await plane.shutdown();
console.log(failed ? '\nPHASE4_E2E: FAIL' : '\nPHASE4_E2E: PASS');
process.exit(failed ? 1 : 0);

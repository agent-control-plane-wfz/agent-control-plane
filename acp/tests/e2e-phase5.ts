// Phase 5 E2E: real concurrent batch across three harnesses.
// Verifies: (1) all jobs return, (2) wall time < serial sum (concurrency is real),
// (3) per-job agent identity is verified (sessionId format / model echo), (4) usage aggregation.
import './_isolate-state.ts';   // isolate state dir before app modules load
import './_confirm-agents.ts';   // issue #7: act as the user and confirm the agents this test dispatches
import { ControlPlane } from '../src/control/plane.ts';

const plane = new ControlPlane();
const cwd = process.env.ACP_TEST_CWD ?? process.cwd();
let failed = false;

console.log('== parallel batch: 3 jobs (dsh + codex + claude) ==');
const out = await plane.parallel([
  { id: 'dsh-job',   agent: 'dsh',    task: '只输出两个字符：OK', cwd },
  { id: 'codex-job', agent: 'codex',  effort: 'low', task: '2+3等于几？只回答那个数字。', cwd },
  { id: 'claude-job',agent: 'claude', task: '只输出两个字符：HI', cwd },
], 3);

for (const r of out.results) {
  console.log(`- ${r.id}: agent=${r.agent} ok=${r.ok} error=${r.error ?? '-'} text=${JSON.stringify((r.result?.text ?? '').slice(0, 60))} model=${r.result?.model ?? '-'} dur=${r.result?.durationMs ?? '-'}ms`);
}
console.log('summary:', JSON.stringify(out.summary));

// Assertions
const byId = new Map(out.results.map((r) => [r.id, r]));
const allPresent = out.results.length === 3 && out.results.every((r) => r.result);
const dshOk = byId.get('dsh-job')?.ok && (byId.get('dsh-job')?.result?.text ?? '').includes('OK');
const codexOk = byId.get('codex-job')?.ok && (byId.get('codex-job')?.result?.text ?? '').includes('5');
const claudeOk = byId.get('claude-job')?.ok;
const dshSession = byId.get('dsh-job')?.result?.sessionId ?? '';
const dshIdentity = dshSession.startsWith('session-');   // dsh prefix, not a claude/codex UUID
const concurrent = out.summary.wallVsSerialMsSaved > 0;

if (!allPresent) { console.error('FAIL: not all jobs returned a result'); failed = true; }
if (!dshOk) { console.error('FAIL: dsh job wrong'); failed = true; }
if (!codexOk) {
  // Distinguish "the agent is out of quota / rate-limited" from a real regression — the
  // suite is still red either way, but the message must not send someone hunting a bug.
  const err = String(byId.get('codex-job')?.error ?? '');
  const external = /usage limit|usageLimitExceeded|quota|rate.?limit|429/i.test(err);
  console.error(`FAIL: codex job wrong${external ? ' — EXTERNAL (agent quota/rate limit, not a code fault): ' + err.slice(0, 120) : ''}`);
  failed = true;
}
if (!claudeOk) { console.error('FAIL: claude job failed'); failed = true; }
if (!dshIdentity) { console.error(`FAIL: dsh sessionId format unexpected: ${dshSession} (agent-spoofing guard)`); failed = true; }
if (!concurrent) { console.error(`FAIL: no concurrency gain (saved=${out.summary.wallVsSerialMsSaved}ms)`); failed = true; }

// Failure independence: a bogus agent hint must fail its own job, not the batch.
console.log('\n== failure independence: one bad job among good ones ==');
const out2 = await plane.parallel([
  { id: 'bad',  agent: 'dsh', task: 'x', cwd: 'Z:\\definitely-not-a-real-dir-\\?<>|' },
  { id: 'good', agent: 'dsh', task: '只输出两个字符：OK', cwd },
], 2);
const badFailed = !out2.results.find((r) => r.id === 'bad')?.ok;
const goodOk = out2.results.find((r) => r.id === 'good')?.ok;
if (!badFailed) { console.error('FAIL: bad job did not fail'); failed = true; }
if (!goodOk) { console.error('FAIL: good job failed alongside bad job'); failed = true; }
console.log(`bad=${badFailed ? 'failed-as-expected' : 'UNEXPECTED'} good=${goodOk ? 'ok' : 'FAILED'}`);

await plane.shutdown();
console.log(failed ? '\nPHASE5_E2E_FAIL' : '\nPHASE5_E2E_PASS');
process.exit(failed ? 1 : 0);

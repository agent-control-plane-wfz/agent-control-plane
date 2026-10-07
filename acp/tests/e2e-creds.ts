// E2E: credential-dependent final verification (Phase 0 leftover).
// Run: node --experimental-strip-types tests/e2e-creds.ts
// Requires: codex logged in (~/.codex/auth.json) + DEEPSEEK_API_KEY in env.
import './_isolate-state.ts';   // isolate state dir before app modules load
import { ControlPlane } from '../src/control/plane.ts';

const cwd = 'D:\\workb\\orchestrator\\phase0';
const plane = new ControlPlane();
let failed = false;

console.log('== codex: real prompt round-trip (effort=low) ==');
const rc = await plane.ask({
  agent: 'codex',
  effort: 'low',
  task: '只输出一个数字：2+3 等于几？不要解释，不要使用任何工具。',
  cwd,
  timeoutMs: 180_000,
});
console.log(JSON.stringify({
  ok: rc.ok, sessionId: rc.sessionId, stopReason: rc.stopReason,
  text: rc.text.slice(0, 200), toolCalls: rc.toolCalls,
  usage: rc.usage, applied: rc.applied, error: rc.error, durationMs: rc.durationMs,
}, null, 2));
if (!rc.ok || !/5/.test(rc.text)) failed = true;

console.log('\n== dsh: headless via ControlPlane ==');
const rd = await plane.ask({
  agent: 'dsh',
  task: '只输出两个字符：OK',
  cwd,
  timeoutMs: 120_000,
});
console.log(JSON.stringify({
  ok: rd.ok, sessionId: rd.sessionId, text: rd.text.slice(0, 100),
  usage: rd.usage, error: rd.error, durationMs: rd.durationMs,
}, null, 2));
if (!rd.ok) failed = true;

console.log('\n== budget after both ==');
console.log(JSON.stringify(plane.budgetStats()));

await plane.shutdown();
console.log(failed ? 'CREDS_E2E: FAIL' : 'CREDS_E2E: PASS');
process.exit(failed ? 1 : 0);

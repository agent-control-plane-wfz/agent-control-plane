// E2E: long-lived session context continuity — spawn(keepSession) then send follow-up.
// Run: node --experimental-strip-types tests/e2e-send.ts
import './_isolate-state.ts';   // isolate state dir before app modules load
import './_confirm-agents.ts';   // issue #7: act as the user and confirm the agents this test dispatches
import { ControlPlane } from '../src/control/plane.ts';

const cwd = 'D:\\workb\\orchestrator\\phase0';
const plane = new ControlPlane();

console.log('== spawn (keepSession) ==');
const r1 = await plane.ask({
  agent: 'dsh',   // stable instruction-following; free-pool opencode has intermittent empty replies
  task: '记住这个数字：42。只回答 OK。',
  cwd,
  keepSession: true,
  timeoutMs: 120_000,
});
console.log(JSON.stringify({ ok: r1.ok, sessionId: r1.sessionId, text: r1.text.slice(0, 120), applied: r1.applied }, null, 2));

if (!r1.ok || !r1.sessionId) {
  console.log('SEND_E2E_SKIP (spawn failed)'); process.exit(1);
}

console.log('\n== send (follow-up, same session) ==');
const r2 = await plane.send('dsh', r1.sessionId, '我刚才让你记住的数字是多少？只回答那个数字。', 120_000);
console.log(JSON.stringify({
  ok: r2.ok, text: r2.text.slice(0, 200), stopReason: r2.stopReason,
  usage: r2.usage, durationMs: r2.durationMs, error: r2.error,
}, null, 2));

console.log('\n== cleanup ==');
const st = await plane.stop('dsh', r1.sessionId!);
console.log(JSON.stringify(st));
await plane.shutdown();

process.exitCode = r2.ok && r2.text.includes('42') ? 0 : 1;
process.exit(process.exitCode);

// E2E acceptance for Phase 1: real round-trip through opencode (authenticated free pool).
// Run: node --experimental-strip-types tests/e2e-opencode.ts
import './_isolate-state.ts';   // isolate state dir before app modules load
import { ControlPlane } from '../src/control/plane.ts';

const cwd = 'D:\\workb\\orchestrator\\phase0';
const plane = new ControlPlane();

console.log('== status ==');
for (const s of plane.status()) {
  console.log(`${s.agent.padEnd(9)} transport=${s.transport.padEnd(12)} auth=${String(s.authenticated).padEnd(9)} effort=[${s.effortLevels.join(',')}] actualVendor=${s.actualVendorNote}`);
}

console.log('\n== route: rule quick ==');
console.log(JSON.stringify(plane.route({ taskType: 'quick' })));

console.log('\n== route: heterogeneity (exclude deepseek) ==');
try {
  console.log(JSON.stringify(plane.route({ taskType: 'review', requirements: { differentVendorFrom: ['deepseek'] } })));
} catch (e: any) {
  console.log('ROUTE_FAIL', e.message);
}

console.log('\n== e2e: ask opencode (real prompt round-trip) ==');
const r = await plane.ask({
  agent: 'opencode',
  task: '只输出一行：1+1 等于几？不要解释。',
  cwd,
  timeoutMs: 120_000,
});
console.log(JSON.stringify({
  ok: r.ok, agent: r.agent, model: r.model, sessionId: r.sessionId,
  stopReason: r.stopReason, toolCalls: r.toolCalls, durationMs: r.durationMs,
  text: r.text.slice(0, 500), error: r.error,
}, null, 2));
if (!r.ok) process.exitCode = 1;

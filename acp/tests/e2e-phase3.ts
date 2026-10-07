// E2E: Phase 3 — workspace worktree mechanism + structured verdict (real opencode call).
// Run: node --experimental-strip-types tests/e2e-phase3.ts
import { ControlPlane } from '../src/control/plane.ts';
import { selfTest } from '../src/workspace/manager.ts';

const cwd = 'D:\\workb\\orchestrator\\phase0';
const plane = new ControlPlane();
let failed = false;

console.log('== workspace self-test (pure git, no LLM) ==');
const wt = await selfTest();
console.log(JSON.stringify(wt));
if (!wt.ok) failed = true;

console.log('\n== ask with structured verdict (codex; instruction-following verified in Phase 4) ==');
const r = await plane.ask({
  agent: 'codex',
  effort: 'low',
  task: '审查这段代码的风险：function add(a, b) { return a + b }  // 调用方传入字符串时无类型检查',
  cwd,
  verdict: true,
  timeoutMs: 150_000,
});
console.log(JSON.stringify({
  ok: r.ok, sessionId: r.sessionId, durationMs: r.durationMs,
  verdict: r.verdict, verdictError: r.verdictError,
  textHead: r.text.slice(0, 200), usage: r.usage,
}, null, 2));
if (!r.verdict) failed = true; // free-pool model should handle a tiny JSON verdict; retry path included

console.log('\n== budget stats ==');
console.log(JSON.stringify(plane.budgetStats()));

await plane.shutdown();
console.log(failed ? 'PHASE3_E2E: FAIL' : 'PHASE3_E2E: PASS');
process.exit(failed ? 1 : 0);

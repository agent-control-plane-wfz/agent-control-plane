// Debug: DshDriver.run via ControlPlane path vs direct.
import './_isolate-state.ts';   // isolate state dir before app modules load
import { DshDriver } from '../src/drivers/dsh-driver.ts';

const cwd = 'D:\\workb\\orchestrator\\phase0';
process.env.DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY ?? '';

const r = await DshDriver.run('只输出两个字符：OK', { cwd, timeoutMs: 120_000 });
console.log(JSON.stringify({
  sessionId: r.sessionId, text: r.text, exitCode: r.exitCode,
  usage: r.usage, eventCount: r.events.length,
  eventTypes: r.events.map((e) => e.type),
  stderrTail: r.stderr.slice(-300),
}, null, 2));

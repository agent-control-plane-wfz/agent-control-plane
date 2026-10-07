// Probe: which session/config setter shape does each ACP agent actually accept?
// Config-only (no prompts, no tokens). Model/effort are restored after each probe.
// Run: node --experimental-strip-types tests/probe-setters.ts
import './_isolate-state.ts';   // isolate state dir before app modules load
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AcpDriver } from '../src/drivers/acp-driver.ts';
import { ControlPlane } from '../src/control/plane.ts';

const here = dirname(fileURLToPath(import.meta.url));
const cwd = 'D:\\workb\\orchestrator\\phase0';
const plane = new ControlPlane();
const results: Record<string, any> = {};

const SHAPES: Array<{ label: string; method: string; params: (sid: string, id: string, v: string, cat?: string) => any }> = [
  { label: 'set_config_option.configId',   method: 'session/set_config_option', params: (sid, id, v) => ({ sessionId: sid, configId: id, value: v }) },
  { label: 'set_config_option.optionId',   method: 'session/set_config_option', params: (sid, id, v) => ({ sessionId: sid, optionId: id, value: v }) },
  { label: 'set_config_option.id',         method: 'session/set_config_option', params: (sid, id, v) => ({ sessionId: sid, id, value: v }) },
  { label: 'set_model',                    method: 'session/set_model',         params: (sid, _id, v) => ({ sessionId: sid, modelId: v }) },
  { label: 'set_mode',                     method: 'session/set_mode',          params: (sid, _id, v) => ({ sessionId: sid, modeId: v }) },
];

for (const agent of ['opencode', 'claude', 'codex'] as const) {
  const entry: any = { probes: [] };
  let session: Awaited<ReturnType<AcpDriver['newSession']>> | undefined;
  try {
    const driver = AcpDriver.from({ agent, ...(plane as any).acpConfigs[agent] });
    const rpc = await driver.connect(cwd);
    session = await driver.newSession(rpc, cwd);

    for (const id of ['model', 'effort', 'mode']) {
      const opt = session.configOptions.find((c) => c.id === id);
      if (!opt?.options || opt.options.length < 2) continue;
      const alt = opt.options.find((o) => o.value !== opt.currentValue)!;
      const probe: any = { option: id, from: opt.currentValue, to: alt.value, attempts: [] };
      let worked: { label: string; method: string } | undefined;
      for (const shape of SHAPES) {
        try {
          const resp = await rpc.request(shape.method, shape.params(session.sessionId, id, alt.value, (opt as any).category), 12_000);
          probe.attempts.push({ shape: shape.label, ok: true, response: JSON.stringify(resp).slice(0, 300) });
          worked = { label: shape.label, method: shape.method };
          break;
        } catch (e: any) {
          probe.attempts.push({ shape: shape.label, ok: false, error: String(e?.message ?? e).slice(0, 200) });
          if (String(e?.message ?? e).includes('timeout')) break; // hung — don't spam
        }
      }
      probe.worked = worked ?? null;
      // restore with the working shape
      if (worked) {
        const back = SHAPES.find((s) => s.label === worked!.label)!;
        try {
          await rpc.request(back.method, back.params(session.sessionId, id, String(opt.currentValue), (opt as any).category), 12_000);
          probe.restored = true;
        } catch (e: any) {
          probe.restored = false;
          probe.restoreError = String(e?.message ?? e).slice(0, 200);
        }
      }
      entry.probes.push(probe);
    }
    await rpc.close();
  } catch (e: any) {
    entry.fatal = String(e?.message ?? e).slice(0, 300);
    if (session) await session.rpc.close();
  }
  results[agent] = entry;
}

writeFileSync(join(here, '..', '..', 'phase0', 'setter-probe.json'), JSON.stringify(results, null, 2), 'utf8');
for (const [a, r] of Object.entries(results)) {
  for (const p of r.probes ?? []) {
    console.log(`${a.padEnd(9)} ${p.option.padEnd(7)} -> ${p.worked ? p.worked.label : 'NONE'} (restored=${p.restored ?? '-'})`);
  }
  if (r.fatal) console.log(`${a} FATAL: ${r.fatal}`);
}
console.log('PROBE_DONE');

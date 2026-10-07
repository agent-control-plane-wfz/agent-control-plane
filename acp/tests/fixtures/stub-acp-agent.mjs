#!/usr/bin/env node
// Minimal ACP agent for tests only. Speaks JSON-RPC over stdio and implements exactly the
// methods AcpDriver uses: initialize / session/new / session/set_config_option /
// session/prompt / session/cancel. No LLM, no network — it echoes the prompt and counts
// turns per session, which is what the keepSession lifecycle test needs to prove that a
// kept session is really still alive.
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin });
let seq = 0;
const sessions = new Map();

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (!msg.method) return;                          // we never issue client requests
  const { id, method, params = {} } = msg;
  const reply = (result) => { if (id !== undefined) send({ jsonrpc: '2.0', id, result }); };

  switch (method) {
    case 'initialize':
      reply({ protocolVersion: 1, authMethods: [], agentCapabilities: {} });
      break;
    case 'session/new': {
      const sessionId = `stub-${++seq}`;
      sessions.set(sessionId, { turns: 0 });
      reply({
        sessionId,
        configOptions: [
          { id: 'model', category: 'model', currentValue: 'stub-model', options: [{ value: 'stub-model', name: 'Stub' }] },
          { id: 'mode', category: 'mode', currentValue: 'default', options: [{ value: 'default', name: 'Default' }] },
          { id: 'effort', category: 'thought_level', currentValue: 'low', options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
        ],
      });
      break;
    }
    case 'session/set_config_option':
      reply({ configOptions: [] });
      break;
    case 'session/prompt': {
      const s = sessions.get(params.sessionId);
      if (s) s.turns += 1;
      const text = (params.prompt ?? []).map((p) => p.text ?? '').join(' ');
      send({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: params.sessionId,
          update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `echo:${text} turns:${s ? s.turns : 0}` } },
        },
      });
      reply({ stopReason: 'end_turn' });
      break;
    }
    case 'session/cancel':
      reply({});
      break;
    default:
      reply({});
  }
});

// MCP stdio server — exposes the Control Plane as 5 tools to ANY MCP host
// (Claude Code / Codex / OpenCode / Gemini CLI ...). Hand-rolled ndjson JSON-RPC, zero deps.
import { createInterface } from 'node:readline';
import { ControlPlane } from '../control/plane.ts';
import type { AgentId } from '../core/types.ts';

const plane = new ControlPlane();
const PROTOCOL = '2024-11-05';

const TOOLS = [
  {
    name: 'ask_agent',
    description: 'Run a task on a coding-agent harness and return its final answer. Routes automatically unless agent/model/effort are given.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The task text' },
        cwd: { type: 'string', description: 'Working directory for the agent' },
        agent: { type: 'string', enum: ['opencode', 'claude', 'codex', 'dsh'] },
        model: { type: 'string' },
        effort: { type: 'string' },
        mode: { type: 'string' },
        taskType: { type: 'string', enum: ['quick', 'code', 'reasoning', 'review'] },
        differentVendorFrom: { type: 'array', items: { type: 'string' }, description: 'Exclude agents whose ACTUAL model vendor is in this list' },
        timeoutMs: { type: 'number' },
        workspaceMode: { type: 'string', enum: ['shared', 'worktree'], description: 'worktree = isolated per-agent git worktree (needs cwd to be a git repo)' },
        verdict: { type: 'boolean', description: 'Structured verdict contract: agent must end with a JSON verdict' },
        maxToolCalls: { type: 'number', description: 'Hard per-call tool-call cap (session cancelled when exceeded)' },
      },
      required: ['task', 'cwd'],
    },
  },
  {
    name: 'review_with',
    description: 'Cross-review: run the task on an agent whose ACTUAL vendor differs from excludeVendors.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string' },
        cwd: { type: 'string' },
        excludeVendors: { type: 'array', items: { type: 'string' }, description: 'e.g. ["deepseek"] to force a non-DeepSeek reviewer' },
        effort: { type: 'string' },
        timeoutMs: { type: 'number' },
      },
      required: ['task', 'cwd', 'excludeVendors'],
    },
  },
  {
    name: 'spawn_agent',
    description: 'Phase 1 alias of ask_agent (session kept open; send support lands in Phase 2).',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string' },
        cwd: { type: 'string' },
        agent: { type: 'string' },
        model: { type: 'string' },
        effort: { type: 'string' },
        timeoutMs: { type: 'number' },
      },
      required: ['task', 'cwd'],
    },
  },
  {
    name: 'send_agent',
    description: 'Continue an existing long-lived session (created by spawn_agent) with a follow-up message.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', enum: ['opencode', 'claude', 'codex', 'dsh'] },
        sessionId: { type: 'string' },
        task: { type: 'string' },
        timeoutMs: { type: 'number' },
      },
      required: ['agent', 'sessionId', 'task'],
    },
  },
  {
    name: 'hetero_review',
    description: 'Phase 4 orchestration: implement -> cross-vendor review (actual vendor enforced) -> neutral verification (objective commands) -> consensus -> optional third-party arbitration.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string' },
        cwd: { type: 'string', description: 'Project directory (git repo if workspaceMode=worktree)' },
        implementer: { type: 'string', enum: ['opencode', 'claude', 'codex', 'dsh'] },
        implementerModel: { type: 'string' },
        implementerEffort: { type: 'string' },
        implementerMode: { type: 'string', description: "e.g. 'acceptEdits' for write tasks" },
        reviewerEffort: { type: 'string' },
        workspaceMode: { type: 'string', enum: ['shared', 'worktree'] },
        verifyCommands: {
          type: 'array', description: 'Neutral gate: commands that must exit 0',
          items: { type: 'object', properties: { cmd: { type: 'string' }, args: { type: 'array', items: { type: 'string' } } }, required: ['cmd'] },
        },
        arbitrateOnConflict: { type: 'boolean' },
        timeoutMs: { type: 'number' },
      },
      required: ['task', 'cwd'],
    },
  },
  {
    name: 'verify',
    description: 'Neutral verification only: run commands in cwd; all must exit 0. No LLM involved.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: { type: 'string' },
        commands: { type: 'array', items: { type: 'object', properties: { cmd: { type: 'string' }, args: { type: 'array', items: { type: 'string' } } }, required: ['cmd'] } },
        timeoutMs: { type: 'number' },
      },
      required: ['cwd', 'commands'],
    },
  },
  {
    name: 'parallel_agents',
    description: 'Phase 5 batch: fan out multiple subtasks concurrently, each with independent routing (agent/model/effort or auto), fallback, budget and verdict. Jobs run in a bounded pool; one job failing never fails the batch.',
    inputSchema: {
      type: 'object',
      properties: {
        jobs: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              task: { type: 'string' },
              cwd: { type: 'string' },
              agent: { type: 'string', enum: ['opencode', 'claude', 'codex', 'dsh'] },
              model: { type: 'string' },
              effort: { type: 'string' },
              taskType: { type: 'string', enum: ['quick', 'code', 'reasoning', 'review'] },
              verdict: { type: 'boolean' },
              maxToolCalls: { type: 'number' },
              workspaceMode: { type: 'string', enum: ['shared', 'worktree'] },
              timeoutMs: { type: 'number' },
            },
            required: ['task', 'cwd'],
          },
        },
        concurrency: { type: 'number', description: 'max parallel jobs (default 3)' },
      },
      required: ['jobs'],
    },
  },
  {
    name: 'stop_agent',
    description: 'Cancel the running prompt of a session.',
    inputSchema: {
      type: 'object',
      properties: { agent: { type: 'string' }, sessionId: { type: 'string' } },
      required: ['agent', 'sessionId'],
    },
  },
  {
    name: 'status',
    description: 'List agents with transport, auth state, models, effort levels and ACTUAL vendor notes.',
    inputSchema: { type: 'object', properties: {} },
  },
];

function text(r: unknown, isError = false) {
  return { content: [{ type: 'text', text: typeof r === 'string' ? r : JSON.stringify(r, null, 2) }], ...(isError ? { isError: true } : {}) };
}

async function callTool(name: string, args: any): Promise<{ content: any[]; isError?: boolean }> {
  try {
    switch (name) {
      case 'status':
        return text({ agents: plane.status(), openSessions: plane.listSessions() });
      case 'ask_agent': {
        const r = await plane.ask({
          task: args.task, cwd: args.cwd,
          agent: args.agent as AgentId | undefined, model: args.model, effort: args.effort,
          mode: args.mode, taskType: args.taskType, differentVendorFrom: args.differentVendorFrom,
          timeoutMs: args.timeoutMs, workspaceMode: args.workspaceMode,
          verdict: args.verdict, maxToolCalls: args.maxToolCalls,
        });
        return text(r, !r.ok);
      }
      case 'spawn_agent': {
        const r = await plane.ask({ ...args, keepSession: true });
        return text(r, !r.ok);
      }
      case 'review_with': {
        const r = await plane.review({
          task: args.task, cwd: args.cwd,
          excludeVendors: args.excludeVendors ?? [],
          effort: args.effort, timeoutMs: args.timeoutMs, verdict: args.verdict,
        });
        return text(r, !r.ok);
      }
      case 'send_agent':
        return text(await plane.send(args.agent as AgentId, args.sessionId, args.task, args.timeoutMs));
      case 'hetero_review': {
        const r = await plane.heteroReview({
          task: args.task, cwd: args.cwd,
          implementer: args.implementer as AgentId | undefined,
          implementerModel: args.implementerModel, implementerEffort: args.implementerEffort,
          implementerMode: args.implementerMode, reviewerEffort: args.reviewerEffort,
          workspaceMode: args.workspaceMode, verifyCommands: args.verifyCommands,
          arbitrateOnConflict: args.arbitrateOnConflict, timeoutMs: args.timeoutMs,
        });
        return text(r, r.consensus === 'failed' || r.consensus === 'verification_failed');
      }
      case 'verify': {
        const { runVerification } = await import('../review/verify.ts');
        const r = await runVerification(args.commands, args.cwd, args.timeoutMs);
        return text(r, !r.allPassed);
      }
      case 'parallel_agents': {
        const r = await plane.parallel(args.jobs, args.concurrency);
        return text(r, r.summary.failed > 0);
      }
      case 'stop_agent':
        return text(await plane.stop(args.agent as AgentId, args.sessionId));
      default:
        return text({ error: `unknown tool ${name}` }, true);
    }
  } catch (e: any) {
    return text({ error: String(e?.message ?? e) }, true);
  }
}

const rl = createInterface({ input: process.stdin });
function write(obj: unknown) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

rl.on('line', async (line) => {
  const s = line.trim();
  if (!s) return;
  let m: any;
  try { m = JSON.parse(s); } catch { return; }
  if (m.id === undefined) return; // notification (e.g. notifications/initialized) — nothing to do
  try {
    if (m.method === 'initialize') {
      write({
        jsonrpc: '2.0', id: m.id,
        result: {
          protocolVersion: PROTOCOL,
          capabilities: { tools: {} },
          serverInfo: { name: 'agent-control-plane', version: '0.1.0' },
        },
      });
    } else if (m.method === 'tools/list') {
      write({ jsonrpc: '2.0', id: m.id, result: { tools: TOOLS } });
    } else if (m.method === 'tools/call') {
      const r = await callTool(m.params.name, m.params.arguments ?? {});
      write({ jsonrpc: '2.0', id: m.id, result: r });
    } else if (m.method === 'ping') {
      write({ jsonrpc: '2.0', id: m.id, result: {} });
    } else {
      write({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `unknown method ${m.method}` } });
    }
  } catch (e: any) {
    write({ jsonrpc: '2.0', id: m.id, error: { code: -32603, message: String(e?.message ?? e) } });
  }
});

process.stderr.write('agent-control-plane MCP server ready\n');

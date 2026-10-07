// LLM router (Phase 2) — classifies ambiguous tasks that no rule matched.
// The classification call itself goes through the RULES path (quick -> opencode),
// so there is no recursion. Disable with ACP_LLM_ROUTER=0.
import type { TaskHints } from './router.ts';
import type { ControlPlane } from '../control/plane.ts';

export type TaskType = NonNullable<TaskHints['taskType']>;

const TYPES: TaskType[] = ['quick', 'code', 'reasoning', 'review'];

const PROMPT = [
  'Classify this coding-related task into exactly one of: quick, code, reasoning, review.',
  'Definitions: quick = mechanical lookup/trivial edit/formatting; code = writing or modifying code;',
  'reasoning = deep analysis, architecture, debugging logic, math; review = checking or auditing existing work.',
  'Reply with ONLY a JSON object: {"taskType":"...","reason":"<10 words max>"}.',
  'Task:',
].join('\n');

export function llmRouterEnabled(): boolean {
  return process.env.ACP_LLM_ROUTER !== '0';
}

export async function classifyTask(plane: ControlPlane, task: string, cwd: string): Promise<{ taskType: TaskType; reason: string } | null> {
  if (!llmRouterEnabled()) return null;
  // C9 (audit): short-circuit when the classifier agent has no credentials — otherwise
  // every ambiguous task would burn its full timeout before doing real work.
  if (plane.registry.requiresAuth('opencode') === true) return null;
  try {
    // Guard against recursion: this call routes through the RULES path (taskType: quick).
    const r = await plane.ask({
      agent: 'opencode',
      taskType: 'quick',
      cwd,
      task: `${PROMPT}\n${task.slice(0, 2000)}`,
      timeoutMs: 20_000, // C9: classification must be cheap — never block a real task for a minute
    });
    if (!r.ok || !r.text) return null;
    const m = r.text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const parsed = JSON.parse(m[0]);
    const tt = String(parsed.taskType ?? '').toLowerCase() as TaskType;
    if (!TYPES.includes(tt)) return null;
    return { taskType: tt, reason: String(parsed.reason ?? 'llm-classified').slice(0, 60) };
  } catch {
    return null; // classification is best-effort; fall back to default chain
  }
}

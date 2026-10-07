// Structured verdict contract (Phase 3). Prompt-side instruction + lenient extraction + validation.
// Fallback design per plan v2.1: codex-fork _meta.outputSchema needs OPENAI key (untested); this works everywhere.

export interface Verdict {
  conclusion: string;
  risks: string[];
  recommendation?: string;
  changedFiles?: string[];
  testsPassed?: boolean;
}

export function verdictInstruction(): string {
  return [
    '',
    '',
    'OUTPUT REQUIREMENT (STRICT / 输出硬性要求): your reply MUST end with a single JSON object in exactly this shape:',
    '{"conclusion":"<one-paragraph conclusion / 一段话结论>","risks":["<risk1>","<risk2>"],"recommendation":"<approve|fix|reject + what to do>","changedFiles":["<path>"],"testsPassed":true|false}',
    'Rules: conclusion and risks are REQUIRED; omit fields you cannot determine; no markdown fences around the JSON; no text after the JSON.',
    '规则：conclusion 与 risks 必填；JSON 之后不要再输出任何内容。',
  ].join('\n');
}

export type VerdictExtract = { ok: true; verdict: Verdict } | { ok: false; error: string; raw: string };

function coerceVerdict(obj: any): Verdict | null {
  if (!obj || typeof obj !== 'object') return null;
  const conclusion = typeof obj.conclusion === 'string' ? obj.conclusion.trim() : '';
  if (!conclusion) return null;
  let risks: string[] = [];
  if (Array.isArray(obj.risks)) risks = obj.risks.map((r: any) => String(r)).filter(Boolean);
  else if (typeof obj.risks === 'string' && obj.risks.trim()) risks = [obj.risks.trim()];
  return {
    conclusion,
    risks,
    recommendation: typeof obj.recommendation === 'string' ? obj.recommendation : undefined,
    changedFiles: Array.isArray(obj.changedFiles) ? obj.changedFiles.map((f: any) => String(f)) : undefined,
    testsPassed: typeof obj.testsPassed === 'boolean' ? obj.testsPassed : undefined,
  };
}

export function extractVerdict(text: string): VerdictExtract {
  if (!text || !text.trim()) return { ok: false, error: 'empty reply', raw: text ?? '' };
  // 1) fenced json block
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates: string[] = [];
  if (fenced) candidates.push(fenced[1]);
  // 2) first balanced {...} scanning from each '{'
  const start = text.indexOf('{');
  if (start >= 0) {
    let depth = 0;
    for (let i = start; i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') {
        depth--;
        if (depth === 0) { candidates.push(text.slice(start, i + 1)); break; }
      }
    }
  }
  // 3) whole text as JSON
  candidates.push(text);
  for (const c of candidates) {
    try {
      const v = coerceVerdict(JSON.parse(c));
      if (v) return { ok: true, verdict: v };
    } catch { /* next candidate */ }
  }
  // 4) last resort: treat whole text as conclusion with empty risks
  return {
    ok: false,
    error: 'no parseable verdict JSON found',
    raw: text.slice(0, 2000),
  };
}

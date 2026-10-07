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

// B2 (audit): retry happens while the session is alive — this prompt is sent as a follow-up turn.
export function VERDICT_RETRY_PROMPT(prevError: string): string {
  return [
    `Your previous reply did not satisfy the required JSON output (${prevError}).`,
    'Reply again. IMPORTANT: output ONLY the JSON object described before — no prose, no markdown, no analysis.',
    '你上一条回复不符合要求的 JSON 输出。请重新回答，只输出那个 JSON 对象本身，不要任何分析或解释。',
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
  // 2) every balanced {...} block — F7 (issue #2): the old code only tried the FIRST `{`,
  //    so a leading example like `示例 {a: 1} 说明` shadowed the real verdict that follows
  //    and burned a retry turn. Scan from each `{` instead.
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{') continue;
    let depth = 0;
    for (let k = i; k < text.length; k++) {
      if (text[k] === '{') depth++;
      else if (text[k] === '}') {
        depth--;
        if (depth === 0) { candidates.push(text.slice(i, k + 1)); i = k; break; }
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

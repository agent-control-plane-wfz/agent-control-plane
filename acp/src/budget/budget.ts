// Budget gates (Phase 3): per-day token/request caps (persisted per day) + per-call tool-call cap.
// Honest fallback: agents that don't report usage (opencode free pool) still consume request count.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TokenUsage } from '../core/types.ts';

const here = dirname(fileURLToPath(import.meta.url));

export interface BudgetOptions {
  dailyTokens?: number;    // sum(input+output) cap per day; 0/undefined = unlimited
  dailyRequests?: number;  // request count cap per day; 0/undefined = unlimited
}

interface DayRecord { date: string; requests: number; tokensIn: number; tokensOut: number; perAgent?: Record<string, number> }

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export class Budget {
  private file: string;
  private rec: DayRecord;
  private opts: BudgetOptions;

  constructor(opts: BudgetOptions = {}) {
    this.opts = opts;
    this.file = join(here, '..', '..', 'state', `budget-${today()}.json`);
    mkdirSync(dirname(this.file), { recursive: true });
    this.rec = this.load();
  }

  private load(): DayRecord {
    const fallback: DayRecord = { date: today(), requests: 0, tokensIn: 0, tokensOut: 0, perAgent: {} };
    try {
      if (existsSync(this.file)) {
        const r = JSON.parse(readFileSync(this.file, 'utf8')) as DayRecord;
        if (r.date === today()) return { perAgent: {}, ...r };
      }
    } catch { /* corrupt file -> fresh */ }
    return fallback;
  }

  private persist(): void {
    try { writeFileSync(this.file, JSON.stringify(this.rec, null, 2), 'utf8'); } catch { /* best-effort */ }
  }

  /** Live-apply new caps from the Settings UI (takes effect on the next checkRequest). */
  update(opts: BudgetOptions): void {
    this.opts = opts;
  }

  checkRequest(): void {
    if (this.opts.dailyRequests && this.rec.requests >= this.opts.dailyRequests) {
      throw new Error(`budget: daily request cap reached (${this.rec.requests}/${this.opts.dailyRequests})`);
    }
    if (this.opts.dailyTokens && this.rec.tokensIn + this.rec.tokensOut >= this.opts.dailyTokens) {
      throw new Error(`budget: daily token cap reached (${this.rec.tokensIn + this.rec.tokensOut}/${this.opts.dailyTokens})`);
    }
  }

  record(usage: TokenUsage | undefined, agent?: string): void {
    this.rec.requests += 1;
    if (agent) {
      this.rec.perAgent = this.rec.perAgent ?? {};
      this.rec.perAgent[agent] = (this.rec.perAgent[agent] ?? 0) + 1;
    }
    if (usage) {
      this.rec.tokensIn += usage.input ?? 0;
      this.rec.tokensOut += usage.output ?? 0;
    }
    this.persist();
  }

  /** Settings UI: wipe today's counters (kept requests history intact otherwise). */
  resetDay(): void {
    this.rec = { date: today(), requests: 0, tokensIn: 0, tokensOut: 0, perAgent: {} };
    this.persist();
  }

  stats(): DayRecord & { caps: BudgetOptions } {
    return { ...this.rec, caps: this.opts };
  }
}

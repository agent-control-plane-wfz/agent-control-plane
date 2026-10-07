// Budget gates (Phase 3): per-day token/request caps (persisted per day) + per-call tool-call cap.
// Honest fallback: agents that don't report usage (opencode free pool) still consume request count.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { TokenUsage } from '../core/types.ts';
import { BUDGET_DIR } from '../config/paths.ts';

export interface BudgetOptions {
  dailyTokens?: number;    // sum(input+output) cap per day; 0/undefined = unlimited
  dailyRequests?: number;  // request count cap per day; 0/undefined = unlimited
  now?: () => Date;        // injectable clock (tests / F4 rollover coverage)
}

interface DayRecord { date: string; requests: number; tokensIn: number; tokensOut: number; perAgent?: Record<string, number> }

// F4 (issue #2): the daily cap must follow the LOCAL day. toISOString() is UTC, so in
// UTC+8 a "daily" cap was resetting at 08:00 local, not midnight.
export function localDay(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export class Budget {
  private file: string;
  private rec: DayRecord;
  private opts: BudgetOptions;
  private day: string;
  private clock: () => Date;

  constructor(opts: BudgetOptions = {}) {
    this.opts = opts;
    this.clock = opts.now ?? (() => new Date());
    this.day = localDay(this.clock());
    this.file = this.fileFor(this.day);
    mkdirSync(dirname(this.file), { recursive: true });
    this.rec = this.load();
  }

  private fileFor(day: string): string {
    return join(BUDGET_DIR, `budget-${day}.json`);
  }

  // F4 (issue #2): a long-running server opened its file at startup and never re-checked
  // the date, so the cap never rolled over until restart. Roll over on every entry point.
  private rollOver(): void {
    const d = localDay(this.clock());
    if (d === this.day) return;
    this.day = d;
    this.file = this.fileFor(d);
    mkdirSync(dirname(this.file), { recursive: true });
    this.rec = this.load();
  }

  private load(): DayRecord {
    const day = localDay(this.clock());
    const fallback: DayRecord = { date: day, requests: 0, tokensIn: 0, tokensOut: 0, perAgent: {} };
    try {
      if (existsSync(this.file)) {
        const r = JSON.parse(readFileSync(this.file, 'utf8')) as DayRecord;
        if (r.date === day) return { perAgent: {}, ...r };
      }
    } catch { /* corrupt file -> fresh */ }
    return fallback;
  }

  private persist(): void {
    try { writeFileSync(this.file, JSON.stringify(this.rec, null, 2), 'utf8'); } catch { /* best-effort */ }
  }

  /** Live-apply new caps from the Settings UI (takes effect on the next checkRequest). */
  update(opts: BudgetOptions): void {
    this.opts = { ...opts, now: this.clock };   // keep the injected clock
  }

  checkRequest(): void {
    this.rollOver();
    if (this.opts.dailyRequests && this.rec.requests >= this.opts.dailyRequests) {
      throw new Error(`budget: daily request cap reached (${this.rec.requests}/${this.opts.dailyRequests})`);
    }
    if (this.opts.dailyTokens && this.rec.tokensIn + this.rec.tokensOut >= this.opts.dailyTokens) {
      throw new Error(`budget: daily token cap reached (${this.rec.tokensIn + this.rec.tokensOut}/${this.opts.dailyTokens})`);
    }
  }

  record(usage: TokenUsage | undefined, agent?: string): void {
    this.rollOver();
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
    this.rollOver();
    this.rec = { date: localDay(this.clock()), requests: 0, tokensIn: 0, tokensOut: 0, perAgent: {} };
    this.persist();
  }

  stats(): DayRecord & { caps: BudgetOptions } {
    this.rollOver();
    return { ...this.rec, caps: this.opts };
  }
}

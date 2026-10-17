import type { CellValue, Row } from './types';

export type PeriodUnit = 'day' | 'week' | 'month' | 'quarter' | 'year';

/** Power BI-style incremental refresh: reload only the recent periods, keep (and trim) history. */
export interface RefreshPolicy {
  /** Date column that places each row in a period. */
  column: string;
  /** Rows dated in the last N periods (counting the current one) are replaced by every refresh. */
  refresh: { last: number; unit: PeriodUnit };
  /** Keep history for the last N periods; older rows are dropped. Default: keep everything. */
  keep?: { last: number; unit: PeriodUnit };
}

export interface IncrementalRefreshResult {
  /** Start of the refreshed window. */
  from: Date;
  /** Start of the kept history, when `keep` is set. */
  keepFrom?: Date;
  /** Rows kept from before the window. */
  kept: number;
  /** Rows removed from the window and replaced. */
  replaced: number;
  /** Incoming rows added (those dated in the window). */
  added: number;
  /** Incoming rows outside the window, ignored. */
  ignored: number;
  /** History rows dropped by `keep`. */
  dropped: number;
}

/** Start of the period `last - 1` periods before the one containing `now` (local calendar). */
export function periodStart(now: Date, unit: PeriodUnit, last: number): Date {
  const back = Math.max(1, Math.floor(last)) - 1;
  const y = now.getFullYear();
  const m = now.getMonth();
  switch (unit) {
    case 'day':
      return new Date(y, m, now.getDate() - back);
    case 'week': {
      // weeks start on Monday
      const monday = now.getDate() - ((now.getDay() + 6) % 7);
      return new Date(y, m, monday - back * 7);
    }
    case 'month':
      return new Date(y, m - back, 1);
    case 'quarter':
      return new Date(y, Math.floor(m / 3) * 3 - back * 3, 1);
    case 'year':
      return new Date(y - back, 0, 1);
  }
}

const timeOf = (v: CellValue | unknown): number | null => {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string' || typeof v === 'number') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.getTime();
  }
  return null;
};

/** Merge a refresh into existing rows under a policy (pure; rows without a date are treated as history). */
export function applyRefreshPolicy(existing: Row[], incoming: Row[], policy: RefreshPolicy, now = new Date()): { rows: Row[]; result: IncrementalRefreshResult } {
  const from = periodStart(now, policy.refresh.unit, policy.refresh.last);
  const keepFrom = policy.keep ? periodStart(now, policy.keep.unit, policy.keep.last) : undefined;
  const f = from.getTime();
  const k = keepFrom?.getTime();
  const rows: Row[] = [];
  let kept = 0;
  let replaced = 0;
  let dropped = 0;
  for (const r of existing) {
    const t = timeOf(r[policy.column]);
    if (t !== null && t >= f) replaced++;
    else if (k !== undefined && t !== null && t < k) dropped++;
    else (rows.push(r), kept++);
  }
  let added = 0;
  let ignored = 0;
  for (const r of incoming) {
    const t = timeOf(r[policy.column]);
    if (t !== null && t >= f) (rows.push(r), added++);
    else ignored++;
  }
  return { rows, result: { from, ...(keepFrom ? { keepFrom } : {}), kept, replaced, added, ignored, dropped } };
}

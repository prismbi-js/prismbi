/**
 * Calendar rules of DAX time intelligence, shared by the evaluator and the single-pass grouped path so both give
 * the same dates.
 */

export const MS_DAY = 86_400_000;

/** `d` moved by `n` months, clamped to the last day of the target month (Mar 31 − 1 month = Feb 28). */
export function addMonths(d: Date, n: number): Date {
  const r = new Date(d.getFullYear(), d.getMonth() + n, 1);
  const last = new Date(r.getFullYear(), r.getMonth() + 1, 0).getDate();
  r.setDate(Math.min(d.getDate(), last));
  return r;
}

/** First day of the period-to-date window ending at `last` (DATESYTD / QTD / MTD); `yearEnd` is `'MM-DD'` or `'MM/DD'`. */
export function periodStart(last: Date, period: 'year' | 'quarter' | 'month', yearEnd?: string): Date {
  if (period === 'year') {
    if (!yearEnd) return new Date(last.getFullYear(), 0, 1);
    const [mm, dd] = yearEnd.split(/[-/]/).map(Number);
    const fyEnd = new Date(last.getFullYear(), mm - 1, dd);
    return last > fyEnd ? new Date(fyEnd.getTime() + MS_DAY) : new Date(new Date(last.getFullYear() - 1, mm - 1, dd).getTime() + MS_DAY);
  }
  if (period === 'quarter') return new Date(last.getFullYear(), Math.floor(last.getMonth() / 3) * 3, 1);
  return new Date(last.getFullYear(), last.getMonth(), 1);
}

/**
 * DATEADD / SAMEPERIODLASTYEAR: the visible dates moved by `n` units (DAY, MONTH, QUARTER, YEAR), kept when they exist.
 * As in DAX, a month's last day also maps to the rest of the target month (Feb 28, 2025 → Feb 28 and 29, 2024).
 */
export function shiftDates(visible: readonly Date[], existing: ReadonlySet<number>, n: number, unit: string): Date[] {
  const shift = (d: Date): Date => {
    if (unit === 'DAY') return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
    if (unit === 'MONTH') return addMonths(d, n);
    if (unit === 'QUARTER') return addMonths(d, n * 3);
    if (unit === 'YEAR') return addMonths(d, n * 12);
    throw new Error(`Unknown interval ${unit}`);
  };
  const shifted = new Map<number, Date>();
  const lastDay = (d: Date) => new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  for (const d of visible) {
    const s = shift(d);
    if (existing.has(s.getTime())) shifted.set(s.getTime(), s);
    if (unit !== 'DAY' && d.getDate() === lastDay(d))
      for (let day = s.getDate() + 1; day <= lastDay(s); day++) {
        const x = new Date(s.getFullYear(), s.getMonth(), day);
        if (existing.has(x.getTime())) shifted.set(x.getTime(), x);
      }
  }
  return [...shifted.values()].sort((a, b) => a.getTime() - b.getTime());
}

/** PARALLELPERIOD / PREVIOUS*: the whole period `n` units (YEAR, QUARTER, else MONTH) from the one containing `first`. */
export function parallelPeriod(first: Date, unit: string, n: number): [start: Date, end: Date] {
  const months = unit === 'YEAR' ? 12 : unit === 'QUARTER' ? 3 : 1;
  const anchor = unit === 'YEAR' ? new Date(first.getFullYear(), 0, 1) : unit === 'QUARTER' ? new Date(first.getFullYear(), Math.floor(first.getMonth() / 3) * 3, 1) : new Date(first.getFullYear(), first.getMonth(), 1);
  const start = addMonths(anchor, n * months);
  return [start, new Date(addMonths(start, months).getTime() - 1)];
}

/**
 * DATESINPERIOD: the window of `n` units (DAY, MONTH, QUARTER, YEAR) from `start`: backwards and ending on it when
 * `n` is negative, forwards and starting on it otherwise.
 */
export function periodWindow(start: Date, n: number, unit: string): [first: Date, last: Date] {
  const day = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  const move = (k: number) => (unit === 'DAY' ? new Date(day.getFullYear(), day.getMonth(), day.getDate() + k) : addMonths(day, k * (unit === 'YEAR' ? 12 : unit === 'QUARTER' ? 3 : 1)));
  const edge = move(n);
  const shift = (d: Date, k: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + k);
  return n < 0 ? [shift(edge, 1), day] : [day, shift(edge, -1)];
}

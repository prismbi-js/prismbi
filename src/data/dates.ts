import type { ColumnSchema, Row } from './types';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export interface DateTableOptions {
  /** First month of the fiscal year, 1-12 (default 1). */
  fiscalYearStartMonth?: number;
  /** First day of week: 0 = Sunday (default), 1 = Monday. */
  weekStart?: 0 | 1;
}

function toDate(d: Date | string): Date {
  if (d instanceof Date) return new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const [y, m, dd] = d.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, dd);
}

/**
 * Generate a calendar table (one row per day) with the usual hierarchy columns:
 * Date, Year, Quarter, QuarterNumber, Month, MonthShort, MonthNumber, MonthYear, YearMonthKey,
 * Day, DayOfWeek, DayOfWeekNumber, WeekOfYear, IsWeekend, FiscalYear, FiscalQuarter.
 * Text columns are pre-wired with `sortBy` so months sort Jan → Dec.
 */
export function generateDateTable(start: Date | string, end: Date | string, opts: DateTableOptions = {}): { rows: Row[]; schema: Record<string, ColumnSchema> } {
  const s = toDate(start);
  const e = toDate(end);
  const fy = (opts.fiscalYearStartMonth ?? 1) - 1;
  const ws = opts.weekStart ?? 0;
  const rows: Row[] = [];
  for (let d = new Date(s); d <= e; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    const y = d.getFullYear();
    const m = d.getMonth();
    const q = Math.floor(m / 3) + 1;
    const jan1 = new Date(y, 0, 1);
    const dow = (d.getDay() - ws + 7) % 7;
    const week = Math.floor(((d.getTime() - jan1.getTime()) / 86_400_000 + ((jan1.getDay() - ws + 7) % 7)) / 7) + 1;
    const fiscalYear = fy === 0 ? y : m >= fy ? y + 1 : y;
    const fiscalMonth = (m - fy + 12) % 12;
    rows.push({
      Date: new Date(d),
      Year: y,
      Quarter: `Q${q}`,
      QuarterNumber: q,
      YearQuarter: `${y} Q${q}`,
      YearQuarterKey: y * 10 + q,
      Month: MONTHS[m],
      MonthShort: MONTHS[m].slice(0, 3),
      MonthNumber: m + 1,
      MonthYear: `${MONTHS[m].slice(0, 3)} ${y}`,
      YearMonthKey: y * 100 + m + 1,
      Day: d.getDate(),
      DayOfWeek: DAYS[d.getDay()],
      DayOfWeekNumber: dow + 1,
      WeekOfYear: week,
      IsWeekend: d.getDay() === 0 || d.getDay() === 6,
      FiscalYear: `FY${fiscalYear}`,
      FiscalQuarter: `FQ${Math.floor(fiscalMonth / 3) + 1}`,
    });
  }
  const schema: Record<string, ColumnSchema> = {
    Date: { type: 'date', format: 'yyyy-MM-dd' },
    Year: { type: 'number', format: '0' },
    Quarter: { type: 'string', sortBy: 'QuarterNumber' },
    QuarterNumber: { type: 'number', hidden: true },
    YearQuarter: { type: 'string', sortBy: 'YearQuarterKey' },
    YearQuarterKey: { type: 'number', hidden: true },
    Month: { type: 'string', sortBy: 'MonthNumber' },
    MonthShort: { type: 'string', sortBy: 'MonthNumber' },
    MonthNumber: { type: 'number', hidden: true },
    MonthYear: { type: 'string', sortBy: 'YearMonthKey' },
    YearMonthKey: { type: 'number', hidden: true },
    Day: { type: 'number', format: '0' },
    DayOfWeek: { type: 'string', sortBy: 'DayOfWeekNumber' },
    DayOfWeekNumber: { type: 'number', hidden: true },
    WeekOfYear: { type: 'number', format: '0' },
    IsWeekend: { type: 'boolean' },
    FiscalYear: { type: 'string' },
    FiscalQuarter: { type: 'string' },
  };
  return { rows, schema };
}

import type { CellValue } from '../data/types';

export type DisplayUnits = 'auto' | 'none' | 'thousands' | 'millions' | 'billions' | 'trillions';

export interface FormatOptions {
  /** Scale numbers (Power BI "Display units"). */
  displayUnits?: DisplayUnits;
  /** Override decimal places. */
  decimals?: number;
  locale?: string;
  /** Text shown for BLANK. */
  blank?: string;
  /** Reference value used by `displayUnits: 'auto'` (e.g. axis max). */
  autoReference?: number;
}

const UNIT_DIV: Record<Exclude<DisplayUnits, 'auto' | 'none'>, [number, string]> = {
  thousands: [1e3, 'K'],
  millions: [1e6, 'M'],
  billions: [1e9, 'bn'],
  trillions: [1e12, 'T'],
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Named presets accepted wherever a format string is. */
export const FORMAT_PRESETS: Record<string, string> = {
  general: '',
  integer: '#,0',
  decimal: '#,0.00',
  percent: '0.0%',
  currency: '$#,0.00',
  currencyWhole: '$#,0',
  shortDate: 'yyyy-MM-dd',
  longDate: 'dddd, MMMM d, yyyy',
  monthYear: 'MMM yyyy',
  year: 'yyyy',
};

export function autoUnits(ref: number): DisplayUnits {
  const a = Math.abs(ref);
  if (a >= 1e12) return 'trillions';
  if (a >= 1e9) return 'billions';
  if (a >= 1e6) return 'millions';
  if (a >= 1e4) return 'thousands';
  return 'none';
}

interface NumberPattern {
  prefix: string;
  suffix: string;
  grouping: boolean;
  minInt: number;
  minFrac: number;
  maxFrac: number;
  percent: boolean;
  scientific: boolean;
  scale: number;
}

const patternCache = new Map<string, NumberPattern>();

function parseNumberPattern(fmt: string): NumberPattern {
  const hit = patternCache.get(fmt);
  if (hit) return hit;
  const m = /^((?:\\.|"[^"]*"|[^#0.,%Ee])*)((?:[#0]|,(?=[#0]))*)(?:\.([#0]*))?((?:[Ee][+-]?0+)?)(,*)((?:\\.|"[^"]*"|.)*)$/.exec(fmt);
  const strip = (s: string) => s.replace(/\\(.)/g, '$1').replace(/"([^"]*)"/g, '$1');
  let p: NumberPattern;
  if (!m) p = { prefix: '', suffix: '', grouping: true, minInt: 1, minFrac: 0, maxFrac: 2, percent: false, scientific: false, scale: 1 };
  else {
    const [, pre, int, frac = '', sci, trailingCommas, post] = m;
    const suffix = strip(post);
    p = {
      prefix: strip(pre),
      suffix,
      grouping: int.includes(','),
      minInt: (int.match(/0/g) ?? []).length,
      minFrac: (frac.match(/0/g) ?? []).length,
      maxFrac: frac.length,
      percent: suffix.includes('%') || strip(pre).includes('%'),
      scientific: !!sci,
      scale: Math.pow(1000, trailingCommas.length),
    };
  }
  patternCache.set(fmt, p);
  return p;
}

let defaultLocale = 'en-US';

/** Locale used when none is passed (deterministic across machines and SSR). Use `'default'` for the browser locale. */
export function setDefaultLocale(locale: string): void {
  defaultLocale = locale;
}

/** Split `pos;neg;zero` format sections (semicolons inside quotes or after a backslash are literal). */
function sections(fmt: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < fmt.length; i++) {
    const ch = fmt[i];
    if (ch === '\\' && i + 1 < fmt.length) {
      cur += ch + fmt[++i];
      continue;
    }
    if (ch === '"') quoted = !quoted;
    if (ch === ';' && !quoted) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

function formatNumber(n: number, fmt: string | undefined, o: FormatOptions): string {
  if (!Number.isFinite(n)) return Number.isNaN(n) ? 'NaN' : n > 0 ? '∞' : '-∞';
  const secs = fmt && fmt.includes(';') ? sections(fmt) : null;
  if (secs && secs.length > 1) {
    const [pos, neg, zero] = secs;
    // a section without digit placeholders is plain text, e.g. "#,0;(#,0);"zero""
    const literal = (sec: string) => (/[0#]/.test(sec.replace(/"[^"]*"/g, '')) ? null : sec.replace(/"([^"]*)"/g, '$1').replace(/\\(.)/g, '$1'));
    if (n === 0 && zero) return literal(zero) ?? formatNumber(0, zero, o);
    // the negative section formats the magnitude and supplies its own sign or parentheses
    if (n < 0 && neg) return formatNumber(-n, neg, o);
    return formatNumber(n, pos, o);
  }
  const locale = o.locale ?? (defaultLocale === 'default' ? undefined : defaultLocale);
  const pattern = parseNumberPattern(fmt || (Number.isInteger(n) ? '#,0' : '#,0.##'));
  let value = n / pattern.scale;
  if (pattern.percent) value *= 100;

  let unitSuffix = '';
  let units = o.displayUnits ?? 'none';
  if (units === 'auto') units = autoUnits(o.autoReference ?? value);
  if (units !== 'none' && !pattern.percent && value !== 0) {
    const [div, sym] = UNIT_DIV[units as keyof typeof UNIT_DIV];
    value /= div;
    unitSuffix = sym;
  }

  let minFrac = pattern.minFrac;
  let maxFrac = pattern.maxFrac;
  if (o.decimals !== undefined) minFrac = maxFrac = o.decimals;
  else if (unitSuffix && pattern.maxFrac === 0) {
    // scaled values keep ~3 significant digits: 9.06M, 12.3K, 450K
    minFrac = 0;
    maxFrac = Math.abs(value) < 10 ? 2 : Math.abs(value) < 100 ? 1 : 0;
    if (!fmt) minFrac = 0;
  }

  if (pattern.scientific) return pattern.prefix + value.toExponential(maxFrac).toUpperCase() + pattern.suffix;

  const body = new Intl.NumberFormat(locale, {
    useGrouping: pattern.grouping,
    minimumIntegerDigits: Math.max(1, pattern.minInt),
    minimumFractionDigits: minFrac,
    maximumFractionDigits: Math.max(minFrac, maxFrac),
  }).format(Math.abs(value));
  const sign = value < 0 && Number(body.replace(/[^0-9]/g, '')) !== 0 ? '-' : '';
  return `${sign}${pattern.prefix}${body}${unitSuffix}${pattern.suffix}`;
}

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0');
}

export function formatDate(d: Date, fmt = 'yyyy-MM-dd'): string {
  return fmt.replace(/yyyy|yy|MMMM|MMM|MM|M|dddd|ddd|dd|d|HH|H|hh|h|mm|ss|tt|q|"[^"]*"/g, (t) => {
    switch (t) {
      case 'yyyy':
        return String(d.getFullYear());
      case 'yy':
        return pad(d.getFullYear() % 100);
      case 'MMMM':
        return MONTHS[d.getMonth()];
      case 'MMM':
        return MONTHS[d.getMonth()].slice(0, 3);
      case 'MM':
        return pad(d.getMonth() + 1);
      case 'M':
        return String(d.getMonth() + 1);
      case 'dddd':
        return DAYS[d.getDay()];
      case 'ddd':
        return DAYS[d.getDay()].slice(0, 3);
      case 'dd':
        return pad(d.getDate());
      case 'd':
        return String(d.getDate());
      case 'HH':
        return pad(d.getHours());
      case 'H':
        return String(d.getHours());
      case 'hh':
        return pad(d.getHours() % 12 || 12);
      case 'h':
        return String(d.getHours() % 12 || 12);
      case 'mm':
        return pad(d.getMinutes());
      case 'ss':
        return pad(d.getSeconds());
      case 'tt':
        return d.getHours() < 12 ? 'AM' : 'PM';
      case 'q':
        return String(Math.floor(d.getMonth() / 3) + 1);
      default:
        return t.slice(1, -1);
    }
  });
}

/**
 * Format any cell value with a Power BI-style format string.
 *
 * Numbers: `#,0` `#,0.00` `0.0%` `$#,0` `€ #,0.0` `0.00E+00` `#,0,` (thousands), presets (`currency`, `percent`, ...).
 * Dates: `yyyy MM dd MMM MMMM ddd dddd HH mm ss tt q`.
 */
export function formatValue(v: CellValue, format?: string, opts: FormatOptions = {}): string {
  if (v === null || v === undefined) return opts.blank ?? '';
  const fmt = format && FORMAT_PRESETS[format] !== undefined ? FORMAT_PRESETS[format] : format;
  if (typeof v === 'number') return formatNumber(v, fmt, opts);
  if (v instanceof Date) {
    if (!fmt) {
      const hasTime = v.getHours() || v.getMinutes() || v.getSeconds();
      return formatDate(v, hasTime ? 'yyyy-MM-dd HH:mm' : 'yyyy-MM-dd');
    }
    return formatDate(v, fmt);
  }
  if (typeof v === 'boolean') return v ? 'True' : 'False';
  return String(v);
}

/** Compact axis label: 0, 250, 1.5K, 12K, 3.4M. */
export function formatCompact(n: number, format?: string, opts: FormatOptions = {}): string {
  return formatValue(n, format, { displayUnits: 'auto', ...opts });
}

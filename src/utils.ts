export type DeepPartial<T> = T extends (infer U)[]
  ? U[]
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

/** Deep merge; `undefined` values in sources are ignored, arrays are replaced. */
export function deepMerge<T>(base: T, ...sources: (Partial<T> | DeepPartial<T> | undefined)[]): T {
  let out: unknown = isPlainObject(base) ? { ...base } : base;
  for (const src of sources) {
    if (!isPlainObject(src)) continue;
    const o = out as Record<string, unknown>;
    for (const [k, v] of Object.entries(src)) {
      if (v === undefined) continue;
      o[k] = isPlainObject(v) && isPlainObject(o[k]) ? deepMerge(o[k], v) : v;
    }
    out = o;
  }
  return out as T;
}

let seq = 0;
export function uid(prefix = 'id'): string {
  return `${prefix}-${Date.now().toString(36)}-${(++seq).toString(36)}`;
}

export class Emitter<E extends Record<string, unknown>> {
  private map = new Map<keyof E, Set<(p: never) => void>>();

  on<K extends keyof E>(event: K, fn: (payload: E[K]) => void): () => void {
    let s = this.map.get(event);
    if (!s) this.map.set(event, (s = new Set()));
    s.add(fn as (p: never) => void);
    return () => this.off(event, fn);
  }

  off<K extends keyof E>(event: K, fn: (payload: E[K]) => void): void {
    this.map.get(event)?.delete(fn as (p: never) => void);
  }

  emit<K extends keyof E>(event: K, payload: E[K]): void {
    for (const fn of this.map.get(event) ?? []) (fn as (p: E[K]) => void)(payload);
  }
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number): (...a: A) => void {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...a: A) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

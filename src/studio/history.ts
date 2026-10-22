/**
 * One edit between two serialized states: replace `len` characters at `at` with `text`. Applied to the newer state
 * it gives the older one (undo steps), or the other way round (redo steps).
 */
interface Splice {
  at: number;
  len: number;
  text: string;
}

/** The smallest single splice turning `a` into `b`: everything between their common prefix and suffix. */
function diff(a: string, b: string): Splice {
  const max = Math.min(a.length, b.length);
  let p = 0;
  while (p < max && a.charCodeAt(p) === b.charCodeAt(p)) p++;
  let q = 0;
  while (q < max - p && a.charCodeAt(a.length - 1 - q) === b.charCodeAt(b.length - 1 - q)) q++;
  return { at: p, len: a.length - p - q, text: b.slice(p, b.length - q) };
}

/** Apply `s` to `str`, returning the result and the splice that reverses it. */
function apply(str: string, s: Splice): [string, Splice] {
  return [str.slice(0, s.at) + s.text + str.slice(s.at + s.len), { at: s.at, len: s.text.length, text: str.slice(s.at, s.at + s.len) }];
}

/**
 * Undo/redo over serialized states. Only the present state is kept whole; each step stores the splice back to its
 * neighbour (an edit usually touches one small region of the JSON), so 200 steps of a large report cost about as
 * much as the edits themselves rather than 200 copies. Identical consecutive states are coalesced.
 */
export class History<T> {
  private past: Splice[] = [];
  private future: Splice[] = [];
  private present: string | null = null;

  constructor(
    private limit = 200,
    private serialize: (v: T) => string = (v) => JSON.stringify(v),
    private parse: (s: string) => T = (s) => JSON.parse(s) as T,
  ) {}

  /** Record a new state (clears redo). Returns false when it equals the current state. */
  push(state: T): boolean {
    const s = this.serialize(state);
    if (s === this.present) return false;
    if (this.present !== null) this.past.push(diff(s, this.present));
    if (this.past.length > this.limit) this.past.shift();
    this.present = s;
    this.future = [];
    return true;
  }

  /** Replace the baseline without creating an undo step (e.g. after load). */
  reset(state: T): void {
    this.past = [];
    this.future = [];
    this.present = this.serialize(state);
  }

  undo(): T | undefined {
    return this.step(this.past, this.future);
  }

  redo(): T | undefined {
    return this.step(this.future, this.past);
  }

  private step(from: Splice[], to: Splice[]): T | undefined {
    const s = from.pop();
    if (s === undefined || this.present === null) return undefined;
    const [next, back] = apply(this.present, s);
    to.push(back);
    this.present = next;
    return this.parse(next);
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  get size(): number {
    return this.past.length;
  }

  /** Characters held for undo and redo, besides the present state (for diagnostics). */
  get stored(): number {
    let n = 0;
    for (const s of this.past) n += s.text.length;
    for (const s of this.future) n += s.text.length;
    return n;
  }
}

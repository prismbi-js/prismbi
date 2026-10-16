/** Snapshot-based undo/redo. States are stored as JSON strings; identical consecutive states are coalesced. */
export class History<T> {
  private past: string[] = [];
  private future: string[] = [];
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
    if (this.present !== null) this.past.push(this.present);
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
    const prev = this.past.pop();
    if (prev === undefined || this.present === null) return undefined;
    this.future.push(this.present);
    this.present = prev;
    return this.parse(prev);
  }

  redo(): T | undefined {
    const next = this.future.pop();
    if (next === undefined || this.present === null) return undefined;
    this.past.push(this.present);
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
}

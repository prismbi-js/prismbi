import type { DataModel, FieldSpec, FilterSpec } from '@prismbi/prismbi';
import { findInsights, type Insight } from './insights';

export interface AnomalyEvent {
  measure: string;
  insight: Insight;
  at: Date;
}

export interface AnomalyWatchOptions {
  measure: FieldSpec;
  filters?: FilterSpec[];
  /** Time column for the series (default: the calendar's year-month or date column). */
  time?: string;
  dimensions?: string[];
  /** Insight kinds that alert (default `['anomaly']`: unusual spikes and dips). */
  kinds?: Insight['kind'][];
  onAnomaly: (e: AnomalyEvent) => void;
  /** Batch bursts of streamed rows (default 0: check on every change). */
  debounceMs?: number;
  /** Also alert for what is already unusual when watching starts (default false). */
  alertExisting?: boolean;
}

/**
 * Watch a measure for unusual changes: re-runs `findInsights` whenever the model changes and calls `onAnomaly`
 * once for each new finding (a spike that was already there when watching started doesn't alert, unless
 * `alertExisting`). Returns a stop function.
 */
export function watchAnomalies(model: DataModel, opts: AnomalyWatchOptions): () => void {
  const kinds = new Set(opts.kinds ?? ['anomaly']);
  const name = typeof opts.measure === 'string' ? opts.measure : (opts.measure.name ?? opts.measure.field ?? 'value');
  const find = () => findInsights(model, { measure: opts.measure, filters: opts.filters, time: opts.time, dimensions: opts.dimensions, max: 20 }).filter((i) => kinds.has(i.kind));
  const seen = new Set<string>();
  const report = (list: Insight[]) => {
    for (const insight of list) {
      if (seen.has(insight.title)) continue;
      seen.add(insight.title);
      opts.onAnomaly({ measure: name, insight, at: new Date() });
    }
  };
  const initial = find();
  if (opts.alertExisting) report(initial);
  else initial.forEach((i) => seen.add(i.title));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = () => {
    timer = undefined;
    report(find());
  };
  const off = model.onChange(() => {
    if (!opts.debounceMs) return check();
    if (timer) clearTimeout(timer);
    timer = setTimeout(check, opts.debounceMs);
  });
  return () => {
    off();
    if (timer) clearTimeout(timer);
  };
}
